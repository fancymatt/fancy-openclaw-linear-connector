
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MutationAuditStore, type MutationAuditInput } from "./mutation-audit-store.js";

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-audit-test-"));
  return path.join(dir, "test.db");
}

describe("MutationAuditStore", () => {
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

  const webhookInput: MutationAuditInput = {
    source: "webhook",
    ticket: "AI-1838",
    changeType: "state",
    field: "state:done",
    oldValue: "state:code-review",
    newValue: "state:done",
    actorId: "user-abc",
    recordedAt: "2026-07-05T20:00:00.000Z",
  };

  const proxyInput: MutationAuditInput = {
    source: "proxy",
    ticket: "AI-1838",
    changeType: "state",
    field: "state:done",
    agent: "hanzo",
    intent: "advance",
    opName: "transitionToAdvance",
    recordedAt: "2026-07-05T19:59:30.000Z",
  };

  test("append inserts a record with correct fields", () => {
    const id = store.append(webhookInput);
    expect(id).toBeGreaterThan(0);

    const records = store.byTicket("AI-1838");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: "webhook",
      ticket: "AI-1838",
      changeType: "state",
      field: "state:done",
      oldValue: "state:code-review",
      newValue: "state:done",
      actorId: "user-abc",
      correlated: 0,
    });
  });

  test("appendBatch inserts multiple records transactionally", () => {
    const ids = store.appendBatch([
      { ...webhookInput, changeType: "delegate", field: "delegateId", newValue: "user-xyz" },
      { ...proxyInput, changeType: "delegate", field: "delegateId", newValue: "user-xyz" },
      { ...webhookInput, changeType: "label", field: "state:done", newValue: "added" },
    ]);
    expect(ids).toHaveLength(3);
    expect(ids.every((id) => id > 0)).toBe(true);

    const records = store.byTicket("AI-1838");
    expect(records).toHaveLength(3);
  });

  test("correlate marks both webhook and proxy records", () => {
    const webhookId = store.append(webhookInput);
    const proxyId = store.append(proxyInput);

    store.correlate(webhookId, proxyId, "2026-07-05T20:01:00.000Z");

    const records = store.byTicket("AI-1838");
    const webhookRec = records.find((r) => r.id === webhookId);
    const proxyRec = records.find((r) => r.id === proxyId);
    expect(webhookRec?.correlated).toBe(1);
    expect(webhookRec?.correlatedAt).toBe("2026-07-05T20:01:00.000Z");
    expect(proxyRec?.correlated).toBe(1);
    expect(proxyRec?.correlatedAt).toBe("2026-07-05T20:01:00.000Z");
  });

  test("findProxyCandidates returns proxy records in time window", () => {
    store.append({ ...proxyInput, recordedAt: "2026-07-05T19:59:00.000Z" });
    store.append({ ...proxyInput, recordedAt: "2026-07-05T19:59:30.000Z" });
    // Outside window
    store.append({ ...proxyInput, recordedAt: "2026-07-05T19:00:00.000Z" });

    const candidates = store.findProxyCandidates(
      "AI-1838",
      "state",
      "2026-07-05T19:59:00.000Z",
      "2026-07-05T20:00:00.000Z",
    );
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.source === "proxy")).toBe(true);
  });

  test("uncorrelatedWebhookMutations returns only uncorrelated webhook records within grace cutoff", () => {
    // Uncorrelated webhook, before cutoff → candidate
    store.append({ ...webhookInput, recordedAt: "2026-07-05T19:50:00.000Z" });
    // Correlated webhook → excluded
    const correlatedId = store.append({ ...webhookInput, recordedAt: "2026-07-05T19:51:00.000Z" });
    const proxyId = store.append({ ...proxyInput, recordedAt: "2026-07-05T19:50:55.000Z" });
    store.correlate(correlatedId, proxyId);
    // Proxy record → excluded (not webhook)
    store.append({ ...proxyInput, recordedAt: "2026-07-05T19:52:00.000Z" });
    // After grace cutoff → excluded (too recent)
    store.append({ ...webhookInput, recordedAt: "2026-07-05T20:10:00.000Z" });

    const unmatched = store.uncorrelatedWebhookMutations(
      ["state", "delegate", "label"],
      "2026-07-05T19:00:00.000Z",
      "2026-07-05T20:00:00.000Z",
    );
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].recordedAt).toBe("2026-07-05T19:50:00.000Z");
  });

  test("uncorrelatedWebhookMutations filters by change type", () => {
    store.append({ ...webhookInput, changeType: "state", recordedAt: "2026-07-05T19:50:00.000Z" });
    store.append({ ...webhookInput, changeType: "delegate", recordedAt: "2026-07-05T19:51:00.000Z" });
    store.append({ ...webhookInput, changeType: "assignee", recordedAt: "2026-07-05T19:52:00.000Z" });

    const stateOnly = store.uncorrelatedWebhookMutations(
      ["state"],
      "2026-07-05T19:00:00.000Z",
      "2026-07-05T20:00:00.000Z",
    );
    expect(stateOnly).toHaveLength(1);
    expect(stateOnly[0].changeType).toBe("state");
  });

  test("stats reports counts correctly", () => {
    store.append(webhookInput); // webhook uncorrelated
    const wId = store.append({ ...webhookInput, field: "state:review" });
    const pId = store.append(proxyInput);
    store.correlate(wId, pId); // webhook + proxy correlated
    store.append({ ...proxyInput, intent: "request-changes" }); // proxy uncorrelated

    const stats = store.stats();
    expect(stats.webhookTotal).toBe(2);
    expect(stats.proxyTotal).toBe(2);
    expect(stats.correlated).toBe(2); // 1 webhook + 1 proxy
    expect(stats.uncorrelated).toBe(1); // 1 uncorrelated webhook
  });

  test("prune removes old records", () => {
    // Insert a record with a very old timestamp
    store.append({ ...webhookInput, recordedAt: "2020-01-01T00:00:00.000Z" });
    store.prune();
    const records = store.byTicket("AI-1838");
    // The 2020 record should be pruned (older than 30 days)
    expect(records.filter((r) => r.recordedAt.startsWith("2020"))).toHaveLength(0);
  });

  test("persist and reopen", () => {
    store.append(webhookInput);
    store.append(proxyInput);
    store.close();

    const reopened = new MutationAuditStore(dbPath);
    const records = reopened.byTicket("AI-1838");
    expect(records).toHaveLength(2);
    reopened.close();
  });
});
