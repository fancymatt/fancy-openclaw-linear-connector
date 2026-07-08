import crypto from "crypto";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { reloadAgents } from "../agents.js";
import { getAlertBus, initAlertBus, _resetAlertBusForTests } from "../alerts/alert-bus.js";
import { resetKnownHumansCache } from "../known-humans.js";
import { OperationalEventStore } from "../store/operational-event-store.js";
import { createWebhookRouter } from "./index.js";

const SECRET = "test-no-route-alert-secret";
const ASTRID_ID = "7a946365-bdf0-4e06-b31a-b90f0cc9fb22";
const UNKNOWN_ID = "00000000-0000-0000-0000-00000000dead";
const MATT_ID = "544710ca-0438-478e-b97f-3aaee89cbb69";

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function createTestApp(operationalEventStore?: OperationalEventStore) {
  const app = express();
  app.use(
    express.raw({ type: "application/json", limit: "1mb" }),
    (req, _res, next) => {
      if (Buffer.isBuffer(req.body)) {
        (req as express.Request & { rawBody?: Buffer }).rawBody = req.body;
      }
      next();
    },
  );
  app.use("/", createWebhookRouter(undefined, undefined, undefined, undefined, undefined, undefined, operationalEventStore));
  return app;
}

async function post(app: express.Express, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload);
  await request(app)
    .post("/")
    .set("linear-signature", sign(body))
    .set("content-type", "application/json")
    .send(body)
    .expect(200);
}

function routingAlerts(): unknown[] {
  return getAlertBus().getStore()!.query({}).filter((row) => row.source === "routing");
}

// The webhook handler ACKs (200) before routing runs, and the routing path
// awaits (bootstrap hook, comment enrichment) — so post() resolving does NOT
// mean the no-route block has executed. Poll for the expected artifact.
async function waitUntil(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Audit #1 follow-up: the no-route warning must page only when the event
// actually named a delegate/assignee/mention we couldn't resolve. Entity
// events with no routing candidates (e.g. IssueLabel create, 2026-07-03
// 2 AM noise) no-route by construction and must stay log+store only.
describe("no-route alert scoping", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-route-alert-test-"));
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          {
            name: "astrid",
            linearUserId: ASTRID_ID,
            openclawAgent: "astrid",
            clientId: "c1",
            clientSecret: "s1",
            accessToken: "tok1",
            refreshToken: "ref1",
          },
        ],
      }),
    );
    process.env.AGENTS_FILE = agentsFile;
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    reloadAgents();
    initAlertBus({ pushEnabled: false });
  });

  afterEach(() => {
    // Restore the jest.setup sentinel rather than deleting: with AGENTS_FILE
    // unset, reloadAgents falls back to the repo-root agents.json, which on a
    // live instance is encrypted and throws — failing every test in afterEach.
    process.env.AGENTS_FILE = path.join(os.tmpdir(), "connector-jest-no-agents.json");
    delete process.env.LINEAR_WEBHOOK_SECRET;
    reloadAgents();
    _resetAlertBusForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("IssueLabel create (no routing candidates) does NOT raise a routing alert", async () => {
    const app = createTestApp();
    await post(app, {
      type: "IssueLabel",
      action: "create",
      actor: { id: "some-human", name: "Matt" },
      data: { id: "lbl-1", name: "new-label", color: "#aabbcc" },
    });
    expect(routingAlerts()).toHaveLength(0);
  });

  test("unassigned Issue create (no routing candidates) does NOT raise a routing alert", async () => {
    const app = createTestApp();
    await post(app, {
      type: "Issue",
      action: "create",
      actor: { id: "some-human", name: "Matt" },
      data: { id: "iss-1", identifier: "AI-9999", title: "unassigned" },
    });
    expect(routingAlerts()).toHaveLength(0);
  });

  test("Issue delegated to an id unknown to agents.json DOES raise a routing alert", async () => {
    const app = createTestApp();
    await post(app, {
      type: "Issue",
      action: "update",
      actor: { id: "some-human", name: "Matt" },
      data: { id: "iss-2", identifier: "AI-9998", title: "misrouted", delegate: { id: UNKNOWN_ID } },
      updatedFrom: { delegateId: null },
    });
    const alerts = routingAlerts();
    expect(alerts).toHaveLength(1);
    expect((alerts[0] as { detail?: string }).detail).toContain(UNKNOWN_ID);
  });

  test("self-triggered no-route with a resolvable delegate does NOT raise a routing alert", async () => {
    const app = createTestApp();
    await post(app, {
      type: "Comment",
      action: "create",
      actor: { id: ASTRID_ID, name: "astrid" },
      data: { id: "cmt-1", body: "progress note", issue: { identifier: "AI-9997" }, delegate: { id: ASTRID_ID } },
    });
    expect(routingAlerts()).toHaveLength(0);
  });
});

// AI-1900 / AI-1826: humans (Matt) are deliberately absent from agents.json,
// so an event on a human-assigned ticket is a CORRECT no-route — it must not
// page. Genuinely unknown ids must keep paging, and a mixed event pages
// listing only the genuinely unknown ids.
describe("known-human no-route resolution", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "known-human-no-route-test-"));
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          {
            name: "astrid",
            linearUserId: ASTRID_ID,
            openclawAgent: "astrid",
            clientId: "c1",
            clientSecret: "s1",
            accessToken: "tok1",
            refreshToken: "ref1",
          },
        ],
      }),
    );
    process.env.AGENTS_FILE = agentsFile;
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    reloadAgents();
    initAlertBus({ pushEnabled: false });
    resetKnownHumansCache();
  });

  afterEach(() => {
    // See note in the suite above: restore the jest.setup sentinel, don't delete.
    process.env.AGENTS_FILE = path.join(os.tmpdir(), "connector-jest-no-agents.json");
    delete process.env.LINEAR_WEBHOOK_SECRET;
    delete process.env.KNOWN_HUMANS_PATH;
    reloadAgents();
    _resetAlertBusForTests();
    resetKnownHumansCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function configureKnownHumans(): void {
    const file = path.join(dir, "known-humans.yaml");
    fs.writeFileSync(file, `known_humans:\n  - id: ${MATT_ID}\n    name: Matt Henry\n`);
    process.env.KNOWN_HUMANS_PATH = file;
  }

  test("event whose only unresolved candidate is a known human → no alert, no-route-human operational outcome", async () => {
    configureKnownHumans();
    const store = new OperationalEventStore(":memory:");
    const app = createTestApp(store);
    await post(app, {
      type: "Issue",
      action: "update",
      actor: { id: MATT_ID, name: "Matt" },
      data: { id: "iss-3", identifier: "AI-9996", title: "matt-assigned", assignee: { id: MATT_ID } },
    });
    await waitUntil(() => store.query({ outcome: "no-route-human" }).length > 0);
    expect(routingAlerts()).toHaveLength(0);
    const events = store.query({ outcome: "no-route-human" });
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe("linear-AI-9996");
    expect(events[0].errorSummary).toContain("Matt Henry");
    expect(store.query({ outcome: "no-route" })).toHaveLength(0);
  });

  test("genuinely unknown id still pages exactly as before", async () => {
    configureKnownHumans();
    const app = createTestApp();
    await post(app, {
      type: "Issue",
      action: "update",
      actor: { id: MATT_ID, name: "Matt" },
      data: { id: "iss-4", identifier: "AI-9995", title: "misrouted", delegate: { id: UNKNOWN_ID } },
    });
    await waitUntil(() => routingAlerts().length > 0);
    const alerts = routingAlerts();
    expect(alerts).toHaveLength(1);
    expect((alerts[0] as { detail?: string }).detail).toContain(UNKNOWN_ID);
  });

  test("mixed event (known human + genuinely unknown) pages listing only the unknown id", async () => {
    configureKnownHumans();
    const store = new OperationalEventStore(":memory:");
    const app = createTestApp(store);
    await post(app, {
      type: "Issue",
      action: "update",
      actor: { id: MATT_ID, name: "Matt" },
      data: { id: "iss-5", identifier: "AI-9994", title: "mixed", assignee: { id: MATT_ID }, delegate: { id: UNKNOWN_ID } },
    });
    await waitUntil(() => routingAlerts().length > 0);
    const alerts = routingAlerts();
    expect(alerts).toHaveLength(1);
    const detail = (alerts[0] as { detail?: string }).detail ?? "";
    expect(detail).toContain(UNKNOWN_ID);
    expect(detail).not.toContain(MATT_ID);
    // Mixed stays an error outcome — a real registry gap is present.
    expect(store.query({ outcome: "no-route" })).toHaveLength(1);
    expect(store.query({ outcome: "no-route-human" })).toHaveLength(0);
  });

  test("without known-humans config, a human id pages as before (exclusion is opt-in)", async () => {
    const app = createTestApp();
    await post(app, {
      type: "Issue",
      action: "update",
      actor: { id: MATT_ID, name: "Matt" },
      data: { id: "iss-6", identifier: "AI-9993", title: "no config", assignee: { id: MATT_ID } },
    });
    await waitUntil(() => routingAlerts().length > 0);
    const alerts = routingAlerts();
    expect(alerts).toHaveLength(1);
    expect((alerts[0] as { detail?: string }).detail).toContain(MATT_ID);
  });

  // AI-1766 AC2: no-route operational events should be keyed by the ticket
  // identifier, not the raw issue UUID. Comment payloads carry no identifier
  // or assignee — normalization strips them — so the routing enrichment fetch
  // (mocked here) grafts identifier + assignee onto the event, exactly the
  // live AI-1826 shape: a comment on a Matt-assigned ticket.
  test("Comment no-route is keyed by the enriched issue identifier, not the raw UUID", async () => {
    configureKnownHumans();
    const store = new OperationalEventStore(":memory:");
    const app = createTestApp(store);
    const originalFetch = global.fetch;
    global.fetch = (async () => ({
      json: async () => ({
        data: { issue: { identifier: "AI-9992", delegate: null, assignee: { id: MATT_ID } } },
      }),
    })) as unknown as typeof fetch;
    try {
      await post(app, {
        type: "Comment",
        action: "create",
        actor: { id: MATT_ID, name: "Matt" },
        data: {
          id: "cmt-2",
          body: "a comment on a matt-assigned ticket",
          issueId: "a15df786-0000-0000-0000-000000000000",
        },
      });
      await waitUntil(() => store.query({ outcome: "no-route-human" }).length > 0);
      expect(routingAlerts()).toHaveLength(0);
      const events = store.query({ outcome: "no-route-human" });
      expect(events).toHaveLength(1);
      expect(events[0].key).toBe("linear-AI-9992");
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("unattributable no-route says why in the operational event", async () => {
    const store = new OperationalEventStore(":memory:");
    const app = createTestApp(store);
    await post(app, {
      type: "Issue",
      action: "update",
      actor: { id: MATT_ID, name: "Matt" },
      data: { id: "iss-7", title: "no identifier in payload", delegate: { id: UNKNOWN_ID } },
    });
    await waitUntil(() => store.query({ outcome: "no-route" }).length > 0);
    const events = store.query({ outcome: "no-route" });
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe("linear-iss-7");
    expect(events[0].errorSummary).toContain("unattributable");
  });
});
