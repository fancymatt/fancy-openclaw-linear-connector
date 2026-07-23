/**
 * AI-2420: per-agent gateway-API delivery (x-openclaw-session-key).
 *
 * Covers the three behaviours the ticket calls out:
 *  1. Per-agent target resolution — delivery hits the agent's OWN gatewayUrl,
 *     with x-openclaw-session-key header routing (not the payload sessionKey).
 *  2. Rollback fallback preserved — with no gateway fields, delivery falls back
 *     to the per-agent hooksUrl payload path (scope-4).
 *  3. Fail-loud — when gateway delivery is required but the agent has no
 *     gateway mapping/token, delivery refuses instead of silently falling
 *     through to the payload-sessionKey hooks path (scope-5).
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { deliverMessageToAgent, type DeliveryConfig } from "./deliver.js";

type FetchCall = { url: string; init: RequestInit };

function installFetchMock(status = 200, body: Record<string, unknown> = { id: "run-123" }): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  globalThis.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls };
}

const originalFetch = globalThis.fetch;
const AGENT = "igor";
const SESSION = "agent:igor:linear-AI-2420";

// No retry/timeout drag in unit tests.
const BASE: Partial<DeliveryConfig> = { nodeBin: "node", maxRetries: 0, timeoutMs: 50 };

describe("AI-2420 per-agent gateway-API delivery", () => {
  beforeEach(() => {
    delete process.env.REQUIRE_GATEWAY_DELIVERY;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
    delete process.env.REQUIRE_GATEWAY_DELIVERY;
  });

  it("routes to the agent's own gatewayUrl with x-openclaw-session-key header", async () => {
    const { calls } = installFetchMock();
    // Two different agents' gateways — resolution must pick the one passed in,
    // never a shared/global URL.
    const igorGateway = "http://10.10.0.105:18820/v1/chat/completions";
    const config: DeliveryConfig = {
      ...BASE,
      nodeBin: "node",
      gatewayUrl: igorGateway,
      gatewayToken: "igor-operator-token",
      // hooks present too — gateway must WIN the preference.
      hooksUrl: "http://host:9999/hooks",
      hooksToken: "hooks-token",
    };

    const result = await deliverMessageToAgent(AGENT, SESSION, "wake up", config);

    expect(result.dispatched).toBe(true);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    // Targeted the agent's own gateway, not the hooks URL.
    expect(call.url).toBe(igorGateway);
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-openclaw-session-key"]).toBe(SESSION);
    expect(headers["Authorization"]).toBe("Bearer igor-operator-token");
    // Agent-first model contract; session rides the header, NOT the payload.
    const payload = JSON.parse(call.init.body as string) as Record<string, unknown>;
    expect(payload.model).toBe(`openclaw/${AGENT}`);
    expect(payload).not.toHaveProperty("sessionKey");
  });

  it("INF-224: agent-prefixes a BARE session key so the gateway binds it to the resolved agent, not main", async () => {
    const { calls } = installFetchMock();
    const config: DeliveryConfig = {
      ...BASE,
      nodeBin: "node",
      gatewayUrl: "http://10.10.0.105:18820/v1/chat/completions",
      gatewayToken: "igor-operator-token",
    };

    // Bare key as produced by normalizeSessionKey (`linear-<ID>`). Left bare,
    // the gateway scopes it to the default agent (`main`) and the dispatch
    // dead-ends. It must be sent as `agent:igor:linear-INF-216`.
    const result = await deliverMessageToAgent(AGENT, "linear-INF-216", "wake up", config);

    expect(result.dispatched).toBe(true);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-openclaw-session-key"]).toBe("agent:igor:linear-INF-216");
  });

  it("INF-224: leaves an already-agent-prefixed session key untouched (idempotent, no double-prefix)", async () => {
    const { calls } = installFetchMock();
    const config: DeliveryConfig = {
      ...BASE,
      nodeBin: "node",
      gatewayUrl: "http://10.10.0.105:18820/v1/chat/completions",
      gatewayToken: "igor-operator-token",
    };

    const result = await deliverMessageToAgent(AGENT, SESSION, "wake up", config);

    expect(result.dispatched).toBe(true);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-openclaw-session-key"]).toBe(SESSION); // unchanged, not agent:igor:agent:igor:...
  });

  it("falls back to the per-agent hooks payload path when no gateway fields are set", async () => {
    const { calls } = installFetchMock(200, { ok: true, runId: "hook-run" });
    const config: DeliveryConfig = {
      ...BASE,
      nodeBin: "node",
      hooksUrl: "http://host:9999/hooks",
      hooksToken: "hooks-token",
    };

    const result = await deliverMessageToAgent(AGENT, SESSION, "wake up", config);

    expect(result.dispatched).toBe(true);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("http://host:9999/hooks");
    // Hooks path carries the session in the PAYLOAD (needs allowRequestSessionKey).
    const payload = JSON.parse(call.init.body as string) as Record<string, unknown>;
    expect(payload.sessionKey).toBe(SESSION);
  });

  it("fails loud (no fetch) when gateway delivery is required but the agent is unmapped", async () => {
    const { calls } = installFetchMock();
    const config: DeliveryConfig = {
      ...BASE,
      nodeBin: "node",
      requireGatewayApi: true,
      // No gatewayUrl/gatewayToken. Hooks present — must NOT be used as a silent fallback.
      hooksUrl: "http://host:9999/hooks",
      hooksToken: "hooks-token",
    };

    const result = await deliverMessageToAgent(AGENT, SESSION, "wake up", config);

    expect(result.dispatched).toBe(false);
    expect(result.hookError).toBe(true);
    expect(result.hookErrorSummary).toMatch(/gatewayUrl\/gatewayToken/);
    // Critically: it did NOT fall through to the hooks payload path.
    expect(calls).toHaveLength(0);
  });

  it("fails loud when only the gateway token is missing (partial mapping)", async () => {
    const { calls } = installFetchMock();
    const config: DeliveryConfig = {
      ...BASE,
      nodeBin: "node",
      requireGatewayApi: true,
      gatewayUrl: "http://10.10.0.105:18820/v1/chat/completions",
      // gatewayToken intentionally absent.
      hooksUrl: "http://host:9999/hooks",
      hooksToken: "hooks-token",
    };

    const result = await deliverMessageToAgent(AGENT, SESSION, "wake up", config);

    expect(result.dispatched).toBe(false);
    expect(result.hookError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("honors the REQUIRE_GATEWAY_DELIVERY env switch as the fleet-wide default", async () => {
    process.env.REQUIRE_GATEWAY_DELIVERY = "true";
    const { calls } = installFetchMock();
    const config: DeliveryConfig = {
      ...BASE,
      nodeBin: "node",
      // requireGatewayApi left undefined — env should drive the decision.
      hooksUrl: "http://host:9999/hooks",
      hooksToken: "hooks-token",
    };

    const result = await deliverMessageToAgent(AGENT, SESSION, "wake up", config);

    expect(result.dispatched).toBe(false);
    expect(result.hookError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
