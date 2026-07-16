import { spawn } from "child_process";
import type { RouteResult } from "../types.js";
import { createLogger, componentLogger } from "../logger.js";
import { buildDeliveryMessage } from "./build-message.js";
import { getAccessToken } from "../agents.js";
import { getActiveCanonVersion } from "../policy/universal-canon.js";

const log = componentLogger(createLogger(), "delivery");

export interface DeliveryConfig {
  nodeBin: string;
  hooksUrl?: string;
  hooksToken?: string;
  hooksThinking?: string;
  hooksModel?: string;
  /** Gateway OpenAI-compatible API URL (e.g. http://10.10.0.105:18789/v1/chat/completions).
   *  When both gatewayUrl+gatewayToken and hooksUrl+hooksToken are present, the
   *  gateway API path is preferred — it uses x-openclaw-session-key instead of
   *  the hook payload field, avoiding the need for allowRequestSessionKey=true.
   *
   *  **These two fields ARE the switch.** Setting both moves this agent's live
   *  delivery to the gateway immediately — there is no separate enable, and no
   *  env var holds it back. See the note at `haveGatewayApi` in
   *  `deliverMessageToAgent` before populating them (AI-2515). */
  gatewayUrl?: string;
  /** Gateway operator token for the OpenAI-compatible API (Authorization: Bearer <token>).
   *  Second half of the switch described on `gatewayUrl` — presence of both
   *  selects the gateway path. */
  gatewayToken?: string;
  /**
   * AI-2420: **This does not select the delivery path.** It only decides what
   * happens to an agent that has *no* `gatewayUrl`+`gatewayToken`: refuse, or
   * fall back to hooks. Nothing here can stop a *populated* agent from using
   * the gateway — path selection is field presence alone (see `haveGatewayApi`
   * in `deliverMessageToAgent`).
   *
   * When true, gateway-API delivery is *required* — an agent without both
   * fields fails loud instead of silently falling back to the hook
   * payload-`sessionKey` path (which needs `allowRequestSessionKey=true` and
   * would silently break once the fleet flips that flag off). When undefined,
   * the delivery layer reads the fleet switch from `REQUIRE_GATEWAY_DELIVERY`
   * (default off — preserves the hooks fallback during the rollout window,
   * AI-2112 scope-4).
   *
   * AI-2515 — the name is a known footgun and is kept only because the rollout
   * depends on its fail-loud behavior. `REQUIRE_GATEWAY_DELIVERY=false` reads
   * like "gateway delivery is off", so it invites the inference that populating
   * `gatewayUrl`/`gatewayToken` is inert prep. It is not: that write is a live
   * cutover for that agent. Two independent sessions made exactly this
   * misreading and came within one refusal of scoping a 27-agent live cutover
   * as "safe prep" (AI-2511, and the AI-2112 07-15 rollout note). If you are
   * about to write a rollout plan on the strength of this flag being off, the
   * flag is not what you think it is.
   */
  requireGatewayApi?: boolean;
  timeoutMs?: number;
  /**
   * Deprecated/unused at this layer. Retry backoff is owned by deliverWithAck,
   * not by the gateway/hooks/CLI delivery primitives.
   */
  retryDelayMs?: number;
  /**
   * Outer scheduler/deliverWithAck retry bound. `wake-up.ts` reads this value
   * and passes it to the acknowledged delivery scheduler; this delivery layer
   * performs exactly one attempt per call.
   */
  maxRetries?: number;
}

export interface DeliveryResult {
  dispatched: boolean;
  runId?: string;
  /** Raw response body from the gateway, for observability. */
  rawResponse?: Record<string, unknown>;
  /** True when the gateway returned { ok: false } or an error body. */
  hookError?: boolean;
  /** Error summary from the gateway (if present in the response). */
  hookErrorSummary?: string;
  /** AI-1428: True when the agent was confirmed unreachable by the pre-flight liveness check. */
  delegateUnavailable?: boolean;
  /** AI-1848: Canon version injected into the dispatch message (null when no canon loaded). */
  canonVersion?: string | null;
  /** The connection was established and the request was accepted; the turn is queued. Not a failure. */
  pendingAck?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function summarizeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classifyFetchError(err: unknown): DeliveryResult {
  const summary = summarizeError(err);
  const name = typeof err === "object" && err !== null && "name" in err
    ? String((err as { name?: unknown }).name)
    : undefined;
  if (name === "AbortError") {
    return {
      dispatched: false,
      pendingAck: true,
      hookErrorSummary: summary,
    };
  }
  return {
    dispatched: false,
    hookError: true,
    hookErrorSummary: summary,
  };
}

/**
 * Deliver a routed event to an OpenClaw agent.
 *
 * Two modes:
 * 1. **HTTP hooks** — POST to an isolated agent endpoint (when hooksUrl + hooksToken configured).
 * 2. **CLI spawn** — run `openclaw agent` as a detached child process (default).
 *
 * Each mode performs exactly one delivery attempt. Retry ownership lives in
 * deliverWithAck / the scheduler layer. Errors are logged, never thrown.
 */
export async function deliverToAgent(
  route: RouteResult,
  config: DeliveryConfig,
): Promise<DeliveryResult> {
  const rawToken =
    getAccessToken(route.agentId) ??
    process.env.LINEAR_OAUTH_TOKEN ??
    process.env.LINEAR_API_KEY;
  const authToken = rawToken
    ? /^Bearer\s+/i.test(rawToken) ? rawToken : `Bearer ${rawToken}`
    : undefined;
  const message = await buildDeliveryMessage(route, authToken);
  // AI-1848: stamp the canon version that was injected by buildDeliveryMessage.
  const canonVersion = getActiveCanonVersion();
  const result = await deliverMessageToAgent(
    route.agentId,
    route.sessionKey,
    message,
    config,
  );
  return { ...result, canonVersion };
}

/** Deliver an explicit operator-authored message to an existing OpenClaw session. */
export async function deliverMessageToAgent(
  agentName: string,
  sessionId: string,
  message: string,
  config: DeliveryConfig,
): Promise<DeliveryResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Prefer the Gateway OpenAI-compatible API path when configured — it uses
  // x-openclaw-session-key header routing instead of the hook payload field,
  // which lets us flip allowRequestSessionKey=false (AI-2111).
  //
  // AI-2515 — THIS LINE IS THE SWITCH. Path selection is field presence and
  // nothing else: no enable flag gates it, and REQUIRE_GATEWAY_DELIVERY does
  // not (it only reaches the refusal branch below). `agents.json` hot-reloads,
  // so writing gatewayUrl+gatewayToken for an agent moves that agent's live
  // delivery from hooks to /v1 the moment the file lands. Populating is a
  // cutover, not inert prep — stage it per agent and treat each write as a
  // production change.
  //
  // Granularity is per-agent, which is the one piece of good news: every
  // DeliveryConfig is built from that agent's own agents.json entry (never a
  // global URL — the fleet is multi-gateway), so populating one agent cuts over
  // exactly that agent. That is what makes a canary possible without any code.
  //
  // Blast radius is not per-agent, though: deliverToAgent delegates here, so
  // this single selection is shared by EVERY delivery path for that agent —
  // Linear webhook dispatch, wake-ups (bag/wake-up.ts), managing-wake, the
  // stuck-delegate-detector, and stale-session re-poke all move together.
  const haveGatewayApi = Boolean(config.gatewayUrl && config.gatewayToken);

  // AI-2420: fail-loud when gateway delivery is mandated fleet-wide but this
  // agent has no gateway mapping/token. Falling through to the hooks path here
  // would deliver via the payload `sessionKey` field, which silently stops
  // working once `allowRequestSessionKey` flips to false — surfacing as
  // mis-routed/dropped dispatches rather than an error. Refuse instead.
  //
  // AI-2515: this branch is the ONLY thing REQUIRE_GATEWAY_DELIVERY gates. Note
  // the predicate — it fires only when the agent is UNpopulated. A populated
  // agent never reaches it and goes to the gateway regardless of this flag.
  const requireGatewayApi = config.requireGatewayApi ?? process.env.REQUIRE_GATEWAY_DELIVERY === "true";
  if (requireGatewayApi && !haveGatewayApi) {
    const summary =
      `gateway-API delivery required (REQUIRE_GATEWAY_DELIVERY) but agent ${agentName} ` +
      `has no gatewayUrl/gatewayToken mapping — refusing silent fallback to payload sessionKey`;
    log.error(`${summary} [${sessionId}]`);
    return { dispatched: false, hookError: true, hookErrorSummary: summary };
  }

  if (haveGatewayApi) {
    return deliverViaGatewayApi(agentName, sessionId, config, { message, timeoutMs });
  }

  if (config.hooksUrl && config.hooksToken) {
    return deliverViaHooks(agentName, sessionId, config, { message, timeoutMs });
  }
  return deliverViaCli(agentName, sessionId, config, { message, timeoutMs });
}

// ── HTTP Hooks Mode ──────────────────────────────────────────────────────────

async function deliverViaHooks(
  agentName: string,
  sessionId: string,
  config: DeliveryConfig,
  opts: { message: string; timeoutMs: number },
): Promise<DeliveryResult> {

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), opts.timeoutMs);
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
        deliver: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    timer = undefined;
    if (!response.ok) {
      const errBody = await response.text().catch(() => "no body");
      throw new Error(`hooks responded with ${response.status}: ${errBody}`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    const runId = typeof json.runId === "string" ? json.runId : undefined;
    const hookOk = json.ok !== false; // Treat missing 'ok' as success (backward compat)

    if (!hookOk) {
      // Gateway explicitly returned { ok: false } — the run was not started.
      const errorSummary = typeof json.error === "string" ? json.error
        : typeof json.summary === "string" ? json.summary
        : JSON.stringify(json).slice(0, 200);
      log.error(
        `Gateway returned hook error for ${agentName} [${sessionId}]: ${errorSummary}`,
      );
      return {
        dispatched: false,
        runId,
        rawResponse: json,
        hookError: true,
        hookErrorSummary: errorSummary,
      };
    }

    log.info(
      `Isolated delivery dispatched for ${agentName} [${sessionId}]: runId=${runId ?? "ok"}`,
    );
    return { dispatched: true, runId, rawResponse: json };
  } catch (err) {
    if (timer) clearTimeout(timer);
    log.error(
      `Isolated delivery failed for ${agentName}: ${summarizeError(err)}`,
    );
    return classifyFetchError(err);
  }
}

// ── Gateway OpenAI-Compatible API Mode ──────────────────────────────────────
//
// Uses POST /v1/chat/completions with x-openclaw-session-key header for
// per-ticket session routing, avoiding the need for allowRequestSessionKey=true
// on the hooks endpoint (AI-2111).
//
// The model field is set to "openclaw/<agentName>" per the Gateway's
// agent-first model contract. The x-openclaw-session-key header routes the
// turn into the correct per-ticket linear-* session.

async function deliverViaGatewayApi(
  agentName: string,
  sessionId: string,
  config: DeliveryConfig,
  opts: { message: string; timeoutMs: number },
): Promise<DeliveryResult> {

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    // Construct the OpenAI-compatible chat completions request body.
    // The model field routes to the specific agent; the message content
    // carries the dispatch message (same as hooks mode).
    const body = JSON.stringify({
      model: `openclaw/${agentName}`,
      messages: [
        {
          role: "user",
          content: opts.message,
        },
      ],
      // Stream=false for a one-shot dispatch; we wait for the response.
      stream: false,
      // Tight max_tokens — the agent's reply is uninteresting here;
      // we just need it to have received and started processing.
      max_tokens: 1,
    });

    const response = await fetch(config.gatewayUrl!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.gatewayToken!}`,
        "Content-Type": "application/json",
        "x-openclaw-session-key": sessionId,
        ...(config.hooksThinking ? { "x-openclaw-model": config.hooksThinking } : {}),
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    timer = undefined;

    if (!response.ok) {
      const errBody = await response.text().catch(() => "no body");
      throw new Error(`gateway API responded with ${response.status}: ${errBody}`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    // The OpenAI-compatible API returns a standard ChatCompletion response.
    // Extract id for run tracking.
    const runId = typeof json.id === "string" ? json.id : undefined;

    log.info(
      `Gateway API delivery dispatched for ${agentName} [${sessionId}]: id=${runId ?? "ok"}`,
    );
    return { dispatched: true, runId, rawResponse: json };
  } catch (err) {
    if (timer) clearTimeout(timer);
    log.error(
      `Gateway API delivery failed for ${agentName}: ${summarizeError(err)}`,
    );
    return classifyFetchError(err);
  }
}

// ── CLI Spawn Mode ───────────────────────────────────────────────────────────

async function deliverViaCli(
  agentName: string,
  sessionId: string,
  config: DeliveryConfig,
  opts: { message: string; timeoutMs: number },
): Promise<DeliveryResult> {

  let result: DeliveryResult = { dispatched: false };
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
      `CLI delivery threw for ${agentName}: ${summarizeError(err)}`,
    );
  }
  if (result.dispatched) {
    log.info(`Delivery spawned for ${agentName} [${sessionId}]`);
  } else {
    log.error(`CLI delivery failed for ${agentName} [${sessionId}]`);
  }
  return result;
}
