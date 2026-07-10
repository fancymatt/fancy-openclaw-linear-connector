/**
 * AI-2036 — the `unspecified` degraded reason code must not feed proposal generation.
 *
 * Fixing the write path makes `observations` finally populate, which in turn
 * wakes the P4-3 distillation cron that has never once run against real data.
 * Its threshold is 3 and it fires hourly, so the first cluster to cross it would
 * be `unspecified` — filing a skill-workshop proposal that reads
 * "unspecified rejected 3× — add checklist + update docs".
 *
 * There is no lesson to distil from "we don't know why". Count it, surface it at
 * /health, never propose from it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { ObservationStore, DEGRADED_REASON_CODE, type StoredReasonCode } from "../store/observation-store.js";
import { runDistillation } from "./p4-metrics-distillation.js";

interface GatewayCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Captures gateway /tools/invoke calls; reports no existing proposals. */
function mockGateway(): { calls: GatewayCall[]; fetch: typeof globalThis.fetch } {
  const calls: GatewayCall[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(body) as GatewayCall;
    calls.push(parsed);
    const result = parsed.args?.action === "list" ? { proposals: [] } : { id: "proposal-1" };
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch: fetchImpl };
}

function seed(store: ObservationStore, reasonCode: StoredReasonCode, times: number): void {
  for (let i = 0; i < times; i++) {
    store.append({
      ticket: `AI-${1000 + i}`,
      workflow: "dev-impl",
      step: "code-review",
      fromBody: "igor",
      reviewerBody: "cra",
      reasonCode,
    });
  }
}

describe("AI-2036: P4-3 distillation ignores the degraded reason code", () => {
  let dir: string;
  let store: ObservationStore;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2036-distill-"));
    store = new ObservationStore(path.join(dir, "observations.db"));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates no proposal when the only threshold-crossing cluster is degraded", async () => {
    seed(store, DEGRADED_REASON_CODE, 5);
    const gateway = mockGateway();
    globalThis.fetch = gateway.fetch;

    const result = await runDistillation(store, 3);

    expect(result.proposalsCreated).toBe(0);
    expect(gateway.calls.filter((c) => c.args?.action === "create")).toHaveLength(0);
  });

  it("still proposes for genuine categories, and ignores the degraded cluster alongside them", async () => {
    seed(store, "missing-tests", 4);
    seed(store, DEGRADED_REASON_CODE, 9); // the larger cluster — must not win
    const gateway = mockGateway();
    globalThis.fetch = gateway.fetch;

    const result = await runDistillation(store, 3);

    expect(result.proposalsCreated).toBe(1);
    const creates = gateway.calls.filter((c) => c.args?.action === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0].args.name).toBe("dev-impl-code-review-missing-tests");
    expect(String(creates[0].args.description)).not.toContain(DEGRADED_REASON_CODE);
  });

  it("still reports degraded clusters as crossed, so they stay visible", async () => {
    seed(store, DEGRADED_REASON_CODE, 5);
    globalThis.fetch = mockGateway().fetch;

    // Silence is what caused AI-2036 in the first place: the cluster is real and
    // counted, it simply is not something to write a checklist about.
    const result = await runDistillation(store, 3);
    expect(result.patternsCrossed).toBe(1);
    expect(result.proposalsCreated).toBe(0);
  });
});
