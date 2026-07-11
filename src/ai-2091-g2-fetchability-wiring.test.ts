/**
 * AI-2091 §2 (G2, AI-2015 / AI-2034) — phantom fetchability gate, WIRED on the
 * PRIMARY dispatch path.
 *
 * The code-review bounce (CodeReviewAgent, 2026-07-11T21:34:51Z) found that
 * `assertDispatchTargetFetchable` was invoked only inside `processStaleSession`
 * (the C4 re-poke path). `src/webhook/index.ts` — the primary path that produces
 * the documented phantom wakes (AI-2014 at 16:45Z "workflow context unavailable",
 * the AI-2034 dead-identifier cluster) — had no fetchability/existence gate and
 * emitted no `phantom-dispatch-abort`. The module-level §2 unit
 * (ai-2091-dispatch-integrity.test.ts) exercises the gate function in isolation
 * and so stays green while the primary path ships ungated.
 *
 * This suite boots the production app factory (`createApp`) and drives a real
 * signed webhook for an UNFETCHABLE ticket through the production dispatch path,
 * asserting the gate aborts with a `phantom-dispatch-abort` operational event and
 * ZERO delivery — not the module-level unit.
 *
 *   AC (of record): "no wake fires on an unfetchable ticket."
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { reloadAgents } from "./agents.js";
import type { OperationalEvent } from "./store/operational-event-store.js";
import { createApp } from "./index.js";

const SECRET = "test-ai2091-g2-secret";

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

/** A wake for a ticket that Linear reports as NOT FOUND at delivery — a phantom.
 *  The delegate points at igor so the event routes via the primary delegate path. */
function phantomDelegateEvent(): string {
  return JSON.stringify({
    type: "Issue",
    action: "create",
    createdAt: "2026-07-11T16:45:00.000Z",
    actor: { id: "a1", name: "System" },
    data: {
      id: "issue-phantom-uuid",
      identifier: "AI-2014",
      title: "phantom / deleted ticket",
      state: { id: "s-doing", name: "Doing", type: "started" },
      delegate: { id: "u-igor" },
      priority: 0,
      team: { id: "t1", key: "AI" },
      labelIds: [],
      url: "https://.app/test/issue/AI-2014",
      createdAt: "2026-07-11T16:45:00.000Z",
      updatedAt: "2026-07-11T16:45:00.000Z",
    },
  });
}

describe("AI-2091 §2 (G2): fetchability gate is wired into the PRIMARY webhook dispatch path", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  let savedSecret: string | undefined;
  let savedSecrets: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2091-g2-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    savedSecret = process.env.LINEAR_WEBHOOK_SECRET;
    savedSecrets = process.env.LINEAR_WEBHOOK_SECRETS;
    delete process.env.LINEAR_WEBHOOK_SECRETS;
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    reloadAgents();

    // Every Linear read at delivery returns a definitive not-found (data.issue =
    // null, OK response, no errors) — the terminal-not-found phantom signal.
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { issue: null } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof globalThis.fetch;

    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      mutationAuditDbPath: path.join(dir, "audit.db"),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.mutationAuditStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
    delete process.env.AGENTS_FILE;
    delete process.env.LINEAR_WEBHOOK_SECRET;
    if (savedSecret !== undefined) process.env.LINEAR_WEBHOOK_SECRET = savedSecret;
    if (savedSecrets !== undefined) process.env.LINEAR_WEBHOOK_SECRETS = savedSecrets;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Poll the operational-event store until `predicate` holds or the budget runs out. */
  async function waitForEvents(
    predicate: (events: OperationalEvent[]) => boolean,
    outcome: string,
    budgetMs = 3000,
  ): Promise<OperationalEvent[]> {
    const deadline = Date.now() + budgetMs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const events = appState.operationalEventStore.query({ outcome, limit: 100 });
      if (predicate(events) || Date.now() > deadline) return events;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("aborts the dispatch with phantom-dispatch-abort and delivers ZERO wakes for an unfetchable ticket", async () => {
    const body = phantomDelegateEvent();
    const res = await request(appState.app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .send(body);

    // The webhook acks immediately; the dispatch runs after the ack.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const aborts = await waitForEvents((e) => e.length > 0, "phantom-dispatch-abort");
    expect(aborts.length).toBeGreaterThan(0);
    expect(aborts.some((e) => e.key === "linear-AI-2014")).toBe(true);

    // ZERO delivery: no wake / bag-add / dispatch-accepted for the phantom ticket.
    const delivered = appState.operationalEventStore.query({ outcome: "delivered", limit: 100 });
    const bagAdded = appState.operationalEventStore.query({ outcome: "bag-added", limit: 100 });
    const dispatchAccepted = appState.operationalEventStore.query({ outcome: "dispatch-accepted", limit: 100 });
    expect(delivered.length).toBe(0);
    expect(bagAdded.length).toBe(0);
    expect(dispatchAccepted.length).toBe(0);
  });
});
