/**
 * AI-2437 — Dispatch delivery: connect-established abort is pending ack, not undeliverable.
 *
 * AC mapping:
 *   AC1 — a connect-established abort resolves as delivered-pending-ack and
 *         registers an ack expectation via DispatchAckTracker.recordDispatch.
 *   AC2 — a connect-established abort is not retried at either delivery layer:
 *         exactly one POST reaches the gateway.
 *   AC3 — genuine unreachability (ECONNREFUSED / ENOTFOUND) and gateway 500
 *         still retry and emit dispatch-undeliverable after exhaustion.
 *   AC4 — retry ownership is pinned here: deliverWithAck owns the retry bound,
 *         deliverMessageToAgent performs one gateway POST per outer attempt.
 *         With maxRetries=3 the observable bound is 4 POSTs, not the old 8x
 *         nested multiplier. The terminal event detail exposes attemptBound.
 *   AC5 — covers connect-established abort, refused/DNS, gateway 500, and
 *         successful delivery.
 *   AC6 — preserves AI-2008 ack/retry behavior and AI-2420 gateway header
 *         routing; wake-up treats the pending-ack status as successful.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jest } from "@jest/globals";
import { deliverWithAck } from "./delivery/deliver-with-ack.js";
import { deliverMessageToAgent, type DeliveryConfig } from "./delivery/deliver.js";
import { sendWakeUpSignal, type WakeUpConfig } from "./bag/wake-up.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";

const GATEWAY_URL = "http://gateway.test/v1/chat/completions";
const GATEWAY_TOKEN = "gw-token-2437";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ai-2437-${prefix}-`));
}

function gatewayConfig(overrides: Partial<DeliveryConfig> = {}): DeliveryConfig {
  return {
    nodeBin: process.execPath,
    gatewayUrl: GATEWAY_URL,
    gatewayToken: GATEWAY_TOKEN,
    retryDelayMs: 0,
    timeoutMs: 5,
    ...overrides,
  };
}

function fetchRejectingOnAbort(): jest.MockedFunction<typeof fetch> {
  return jest.fn((_url, init) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const abort = (): void => {
        reject(new DOMException("This operation was aborted", "AbortError"));
      };
      if (signal?.aborted) {
        abort();
      } else {
        signal?.addEventListener("abort", abort, { once: true });
      }
    });
  }) as jest.MockedFunction<typeof fetch>;
}

function fetchRejectingWithCause(code: string): jest.MockedFunction<typeof fetch> {
  return jest.fn(async () => {
    const err = new TypeError("fetch failed") as TypeError & { cause?: { code: string } };
    err.cause = { code };
    throw err;
  }) as jest.MockedFunction<typeof fetch>;
}

function fetchGateway500(): jest.MockedFunction<typeof fetch> {
  return jest.fn(async () => ({
    ok: false,
    status: 500,
    text: async () => "boom",
  }) as Response) as jest.MockedFunction<typeof fetch>;
}

function fetchSuccess(): jest.MockedFunction<typeof fetch> {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: "run-123" }),
  }) as Response) as jest.MockedFunction<typeof fetch>;
}

describe("AI-2437 gateway dispatch delivery classification and retry bounds", () => {
  let dir: string;
  let eventStore: OperationalEventStore;
  let ackTracker: DispatchAckTracker;
  let originalFetch: typeof globalThis.fetch;
  let sleeps: number[];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };

  beforeEach(() => {
    dir = tmpDir("dispatch");
    eventStore = new OperationalEventStore(path.join(dir, "events.db"));
    ackTracker = new DispatchAckTracker(path.join(dir, "acks.db"));
    originalFetch = globalThis.fetch;
    sleeps = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    eventStore.close();
    ackTracker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC1/AC2 connect-established abort is delivered-pending-ack, records ack, and sends exactly one POST", async () => {
    const fetchMock = fetchRejectingOnAbort();
    globalThis.fetch = fetchMock;

    const outcome = await deliverWithAck({
      agentId: "igor",
      ticketId: "AI-2437",
      workflowState: "implementation",
      gateway: "grover",
      dispatchId: "disp-connect-abort",
      deliver: async () =>
        deliverMessageToAgent(
          "igor",
          "linear-ai-2437",
          "dispatch turn after connection established",
          gatewayConfig(),
        ),
      eventStore,
      ackTracker,
      maxRetries: 3,
      backoffMs: () => 0,
      sleep,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("delivered-pending-ack");
    expect(outcome.attempts).toBe(1);

    const acks = ackTracker.listRecent();
    expect(acks.some((a) => a.agentId === "igor" && a.ticketId === "linear-AI-2437")).toBe(true);

    const events = eventStore.query({ key: "linear-AI-2437" });
    expect(events.some((e) => e.outcome === "dispatch-undeliverable")).toBe(false);
  });

  it.each([
    ["connection refused", "ECONNREFUSED"],
    ["DNS failure", "ENOTFOUND"],
  ])("AC3 %s still retries and emits dispatch-undeliverable after exhaustion", async (_label, code) => {
    const fetchMock = fetchRejectingWithCause(code);
    globalThis.fetch = fetchMock;

    const outcome = await deliverWithAck({
      agentId: "igor",
      ticketId: "AI-2437",
      workflowState: "implementation",
      gateway: "grover",
      dispatchId: `disp-${code.toLowerCase()}`,
      deliver: async () =>
        deliverMessageToAgent(
          "igor",
          "linear-AI-2437",
          "dispatch turn to unreachable gateway",
          gatewayConfig({ maxRetries: 0 }),
        ),
      eventStore,
      ackTracker,
      maxRetries: 1,
      backoffMs: () => 0,
      sleep,
    });

    expect(outcome.status).toBe("undeliverable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([0]);

    const events = eventStore.query({ key: "linear-AI-2437" });
    expect(events.some((e) => e.outcome === "dispatch-undeliverable")).toBe(true);
  });

  it("AC3/AC4 connection refused has one retry owner: 4 outer attempts produce 4 POSTs and attemptBound=4", async () => {
    const fetchMock = fetchRejectingWithCause("ECONNREFUSED");
    globalThis.fetch = fetchMock;

    const outcome = await deliverWithAck({
      agentId: "igor",
      ticketId: "AI-2437",
      workflowState: "implementation",
      gateway: "grover",
      dispatchId: "disp-refused-bound",
      deliver: async () =>
        deliverMessageToAgent(
          "igor",
          "linear-AI-2437",
          "dispatch turn to unreachable gateway",
          gatewayConfig(),
        ),
      eventStore,
      ackTracker,
      maxRetries: 3,
      backoffMs: () => 0,
      sleep,
    });

    expect(outcome.status).toBe("undeliverable");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const warning = eventStore
      .query({ key: "linear-AI-2437" })
      .find((e) => e.outcome === "dispatch-undeliverable");
    expect(warning).toBeDefined();
    expect(warning!.attemptCount).toBe(fetchMock.mock.calls.length);
    expect((warning!.detail as Record<string, unknown>).attemptBound).toBe(fetchMock.mock.calls.length);
  });

  it("AC3/AC4 gateway 500 has one retry owner: 4 outer attempts produce 4 POSTs and attemptBound=4", async () => {
    const fetchMock = fetchGateway500();
    globalThis.fetch = fetchMock;

    const outcome = await deliverWithAck({
      agentId: "igor",
      ticketId: "AI-2437",
      workflowState: "implementation",
      gateway: "grover",
      dispatchId: "disp-500-bound",
      deliver: async () =>
        deliverMessageToAgent(
          "igor",
          "linear-AI-2437",
          "dispatch turn to gateway returning 500",
          gatewayConfig(),
        ),
      eventStore,
      ackTracker,
      maxRetries: 3,
      backoffMs: () => 0,
      sleep,
    });

    expect(outcome.status).toBe("undeliverable");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const warning = eventStore
      .query({ key: "linear-AI-2437" })
      .find((e) => e.outcome === "dispatch-undeliverable");
    expect(warning).toBeDefined();
    expect(warning!.attemptCount).toBe(fetchMock.mock.calls.length);
    expect((warning!.detail as Record<string, unknown>).attemptBound).toBe(fetchMock.mock.calls.length);
  });

  it("AC5/AC6 successful delivery is unchanged and preserves AI-2420 gateway headers", async () => {
    const fetchMock = fetchSuccess();
    globalThis.fetch = fetchMock;

    const outcome = await deliverWithAck({
      agentId: "igor",
      ticketId: "AI-2437",
      workflowState: "implementation",
      gateway: "grover",
      dispatchId: "disp-success",
      deliver: async () =>
        deliverMessageToAgent(
          "igor",
          "linear-ai-2437",
          "dispatch turn that starts successfully",
          gatewayConfig(),
        ),
      eventStore,
      ackTracker,
      maxRetries: 3,
      backoffMs: () => 0,
      sleep,
    });

    expect(outcome.status).toBe("delivered");
    expect(outcome.attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [_url, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
      "x-openclaw-session-key": "linear-ai-2437",
    });
  });
});

describe("AI-2437 wake-up integration", () => {
  it("AC1/AC6 sendWakeUpSignal treats delivered-pending-ack as success", async () => {
    const dispatch = jest.fn(async () => ({
      status: "delivered-pending-ack",
      attempts: 1,
      dispatchId: "wake-linear-AI-2437-test",
    }));
    const config: WakeUpConfig = {
      nodeBin: process.execPath,
      deliveryScheduler: { dispatch } as WakeUpConfig["deliveryScheduler"],
      workflowState: "implementation",
      gateway: "grover",
    };

    await expect(sendWakeUpSignal("igor", ["linear-ai-2437"], config)).resolves.toEqual({
      canonVersion: undefined,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
