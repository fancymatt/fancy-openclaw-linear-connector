/**
 * AI-1843 — Multi-mutation proxy audit change-type coverage.
 *
 * Regression test for the false-positive OOB flag bug: proxy-forwarded
 * workflow transitions (e.g. handoff-work) change state + delegate atomically,
 * but the proxy audit hard-coded changeType="state". The reconcile sweep
 * matches by exact change_type, so the webhook's delegate change found no
 * matching proxy record → false-positive out-of-band flag.
 *
 * These tests verify the fix: the proxy now records one audit entry per
 * change type the transition produces, and multi-faceted transitions produce
 * zero false OOB flags.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MutationAuditStore, type MutationAuditInput } from "./store/mutation-audit-store.js";
import { reconcileOobMutations } from "./oob-reconcile-sweep.js";

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1843-test-"));
  return path.join(dir, "test.db");
}

const NOW = new Date("2026-07-05T22:00:00.000Z").getTime();
const PROXY_TIME = "2026-07-05T21:29:00.000Z";
const WEBHOOK_TIME = "2026-07-05T21:30:00.000Z";

/**
 * Simulates what the fixed proxy does for a workflow intent: append one audit
 * record per change type the transition's applyStateTransition produces.
 */
function recordProxyTransition(
  store: MutationAuditStore,
  ticket: string,
  intent: string,
  changeTypes: Array<"state" | "label" | "delegate" | "assignee">,
  recordedAt = PROXY_TIME,
): void {
  const records: MutationAuditInput[] = changeTypes.map((ct) => ({
    source: "proxy",
    ticket,
    changeType: ct,
    field: `intent:${intent}`,
    agent: "charles",
    intent,
    recordedAt,
  }));
  store.appendBatch(records);
}

/**
 * Simulates what Linear webhooks record for an atomic state+delegate transition.
 */
function recordWebhookObservations(
  store: MutationAuditStore,
  ticket: string,
  changes: Array<{ changeType: "state" | "label" | "delegate"; field: string }>,
  recordedAt = WEBHOOK_TIME,
): void {
  for (const c of changes) {
    store.append({
      source: "webhook",
      ticket,
      changeType: c.changeType,
      field: c.field,
      actorId: "linear-bot",
      recordedAt,
    });
  }
}

describe("AI-1843: multi-mutation proxy audit change types", () => {
  let store: MutationAuditStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDb();
    store = new MutationAuditStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test("handoff-work (state + delegate) produces zero OOB flags", async () => {
    // Proxy forwarded handoff-work: now records state + label + delegate
    recordProxyTransition(store, "AI-5001", "handoff-work", [
      "state",
      "label",
      "delegate",
    ]);

    // Webhook observes: native stateId change, state:* label swap, delegate change
    recordWebhookObservations(store, "AI-5001", [
      { changeType: "state", field: "state:implementation" },
      { changeType: "label", field: "state:implementation" },
      { changeType: "delegate", field: "delegateId" },
    ]);

    const result = await reconcileOobMutations(store, {
      nowMs: NOW,
      graceMs: 60_000,
    });

    expect(result.examined).toBe(3);
    expect(result.correlated).toBe(3);
    expect(result.flagged).toBe(0);
  });

  test("delegate-only webhook change is matched when proxy recorded delegate type", async () => {
    // Before AI-1843: proxy only had changeType="state", so a delegate webhook
    // was always flagged. Now the proxy records "delegate" too.
    recordProxyTransition(store, "AI-5002", "handoff-work", [
      "state",
      "label",
      "delegate",
    ]);

    // Only the delegate webhook fires in this test
    recordWebhookObservations(store, "AI-5002", [
      { changeType: "delegate", field: "delegateId" },
    ]);

    const result = await reconcileOobMutations(store, {
      nowMs: NOW,
      graceMs: 60_000,
    });

    expect(result.correlated).toBe(1);
    expect(result.flagged).toBe(0);
  });

  test("label change (state:* label swap) is matched when proxy recorded label type", async () => {
    recordProxyTransition(store, "AI-5003", "advance", [
      "state",
      "label",
      "delegate",
    ]);

    recordWebhookObservations(store, "AI-5003", [
      { changeType: "label", field: "state:code-review" },
    ]);

    const result = await reconcileOobMutations(store, {
      nowMs: NOW,
      graceMs: 60_000,
    });

    expect(result.correlated).toBe(1);
    expect(result.flagged).toBe(0);
  });

  test("regression: old single-state proxy record still flags delegate change", async () => {
    // Simulate the OLD (buggy) behavior: only changeType="state" recorded.
    recordProxyTransition(store, "AI-5004", "handoff-work", ["state"]);

    // Webhook fires state + delegate
    recordWebhookObservations(store, "AI-5004", [
      { changeType: "state", field: "state:implementation" },
      { changeType: "delegate", field: "delegateId" },
    ]);

    const result = await reconcileOobMutations(store, {
      nowMs: NOW,
      graceMs: 60_000,
    });

    // The state webhook correlates, but the delegate webhook has no proxy match → flagged
    expect(result.correlated).toBe(1);
    expect(result.flagged).toBe(1);
    expect(result.flaggedDetails[0].changeType).toBe("delegate");
  });

  test("genuine out-of-band delegate change is still flagged", async () => {
    // Proxy did a transition with full change type coverage
    recordProxyTransition(store, "AI-5005", "advance", [
      "state",
      "label",
      "delegate",
    ]);

    // Webhook for the proxied state change
    recordWebhookObservations(store, "AI-5005", [
      { changeType: "state", field: "state:code-review" },
      { changeType: "label", field: "state:code-review" },
      { changeType: "delegate", field: "delegateId" },
    ]);

    // A separate genuine out-of-band delegate change on a different ticket
    recordWebhookObservations(store, "AI-5006", [
      { changeType: "delegate", field: "delegateId" },
    ]);

    const result = await reconcileOobMutations(store, {
      nowMs: NOW,
      graceMs: 60_000,
    });

    expect(result.correlated).toBe(3);
    expect(result.flagged).toBe(1);
    expect(result.flaggedDetails[0].ticket).toBe("AI-5006");
  });

  test("multiple transitions on same ticket each find their own proxy match", async () => {
    // First transition at 21:00
    recordProxyTransition(store, "AI-5007", "accept", [
      "state",
      "label",
      "delegate",
    ], "2026-07-05T21:00:00.000Z");
    recordWebhookObservations(store, "AI-5007", [
      { changeType: "state", field: "state:implementation" },
      { changeType: "label", field: "state:implementation" },
      { changeType: "delegate", field: "delegateId" },
    ], "2026-07-05T21:00:30.000Z");

    // Second transition at 21:30
    recordProxyTransition(store, "AI-5007", "submit", [
      "state",
      "label",
      "delegate",
    ], "2026-07-05T21:30:00.000Z");
    recordWebhookObservations(store, "AI-5007", [
      { changeType: "state", field: "state:code-review" },
      { changeType: "label", field: "state:code-review" },
      { changeType: "delegate", field: "delegateId" },
    ], "2026-07-05T21:30:30.000Z");

    const result = await reconcileOobMutations(store, {
      nowMs: NOW,
      graceMs: 60_000,
    });

    expect(result.examined).toBe(6);
    expect(result.correlated).toBe(6);
    expect(result.flagged).toBe(0);
  });
});
