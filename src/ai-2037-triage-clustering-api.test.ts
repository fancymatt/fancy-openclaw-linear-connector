/**
 * AI-2037 / P4-C2 — Triage pipeline: failure clustering + console API.
 *
 * Written RED before implementation (dev-impl `write-tests`). The endpoint
 * under test does not exist yet.
 *
 * ── Pinned endpoint contract ────────────────────────────────────────────────
 * The ticket asks for the contract to be published early so C5 (console UI)
 * can mock against it. These tests pin it:
 *
 *   GET /admin/api/triage/clusters
 *     ?kind=observations | operational-events | alerts   (default: observations)
 *     &threshold=<int>   — sets the exceedsThreshold flag (count >= threshold)
 *     &since=&until=     — ISO bounds, optional
 *     &limit=<int>       — optional
 *
 *   200 → { kind, clusters: [...], summary: {...}, query: {...} }
 *
 *   kind=observations       cluster: { workflow, step, reasonCode, count,
 *                                      exceedsThreshold, tickets: string[] }
 *   kind=operational-events cluster: { workflowState, plane, outcome, count,
 *                                      exceedsThreshold, wakeIds: string[] }
 *                           plus top-level `excludedPreEnrichmentRows: number`
 *   kind=alerts             cluster: { source, dedupKey, agent, count,
 *                                      exceedsThreshold }
 *
 * ── AC mapping ─────────────────────────────────────────────────────────────
 *   AC2.1 — "observations clusters expose (workflow, step, reasonCode) + count
 *            + exceedsThreshold + contributing ticket ids"
 *          + "ObservationStore.metrics() itself carries contributing ticket ids"
 *            (the "backed by ObservationStore.metrics()" clause)
 *   AC2.2 — "excludes signature-rejected and duplicate event classes"
 *          + "filters stale-digest noise (dropped-stale / suppressed-duplicate)"
 *   AC2.3 — "alert-store clusters by (source, dedupKey, agent) via the same API"
 *   AC2.4 — "clustering is computed on demand" (the bootstrap-wiring + liveness
 *            half of AC2.4 lives in ai-2037-distillation-liveness-bootstrap.test.ts)
 *   AC2.5 — "operational-events clusters use forward-only enrichment columns"
 *          + "makes no claim over pre-enrichment historical rows"
 */

import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { AlertStore } from "./alerts/alert-store.js";
import { initAlertBus, _resetAlertBusForTests } from "./alerts/alert-bus.js";
import type { OperationalEventOutcome } from "./store/operational-event-store.js";

const ADMIN_SECRET = "ai-2037-test-secret";
const CLUSTERS = "/admin/api/triage/clusters";

function adminGet(app: ReturnType<typeof createApp>["app"], route: string) {
  return request(app).get(route).set("x-admin-secret", ADMIN_SECRET);
}

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [{
      name: "igor",
      linearUserId: "user-igor-12345678",
      openclawAgent: "igor",
      clientId: "cid",
      clientSecret: "csec",
      accessToken: "tok",
      refreshToken: "ref",
      host: "local",
    }],
  }), "utf8");
  return file;
}

/** The two event classes AC2.2 names explicitly. */
const EXCLUDED_EVENT_CLASSES = ["signature-rejected", "duplicate"];

/**
 * Stale-digest noise emitted by the old connector bugs — see
 * src/webhook/index.ts:549 (`dropped-stale`) and :562 (`suppressed-duplicate`).
 * AC2.2: this noise is "filtered, not clustered".
 */
const STALE_DIGEST_NOISE = ["dropped-stale", "suppressed-duplicate"];

describe("AI-2037: triage clustering console API", () => {
  let dir: string;
  let webDist: string;
  let appState: ReturnType<typeof createApp>;
  let alertStore: AlertStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2037-test-"));
    webDist = path.join(dir, "web-dist");
    fs.mkdirSync(webDist, { recursive: true });
    fs.writeFileSync(
      path.join(webDist, "index.html"),
      "<!doctype html><title>Linear Connector Console</title><div id=\"root\"></div>",
      "utf8",
    );
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.ADMIN_WEB_DIST = webDist;
    reloadAgents();

    alertStore = new AlertStore(":memory:");
    initAlertBus({ store: alertStore, pushEnabled: false });

    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled-tickets.db"),
    });
  });

  afterEach(() => {
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.observationStore.close();
    alertStore.close();
    _resetAlertBusForTests();
    delete process.env.AGENTS_FILE;
    delete process.env.ADMIN_SECRET;
    delete process.env.ADMIN_WEB_DIST;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── AC2.1 ────────────────────────────────────────────────────────────────
  describe("AC2.1: observation clusters by (workflow, step, reason_code)", () => {
    /** Three missing-tests rejects on one step, one style reject on the same step. */
    function seedObservations(): void {
      const base = {
        workflow: "dev-impl",
        step: "code-review",
        fromBody: "igor",
        reviewerBody: "cra",
      } as const;
      appState.observationStore.append({ ...base, ticket: "AI-3001", reasonCode: "missing-tests" });
      appState.observationStore.append({ ...base, ticket: "AI-3002", reasonCode: "missing-tests" });
      appState.observationStore.append({ ...base, ticket: "AI-3003", reasonCode: "missing-tests" });
      appState.observationStore.append({ ...base, ticket: "AI-3004", reasonCode: "style" });
    }

    test("returns a cluster per (workflow, step, reasonCode) with count, exceedsThreshold and contributing ticket ids", async () => {
      seedObservations();

      const res = await adminGet(appState.app, `${CLUSTERS}?kind=observations&threshold=3`);
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("observations");

      const clusters = res.body.clusters as Array<Record<string, unknown>>;
      expect(Array.isArray(clusters)).toBe(true);

      const missingTests = clusters.find(
        (c) => c.workflow === "dev-impl" && c.step === "code-review" && c.reasonCode === "missing-tests",
      );
      expect(missingTests).toBeDefined();
      expect(missingTests!.count).toBe(3);
      // count (3) >= threshold (3)
      expect(missingTests!.exceedsThreshold).toBe(true);
      // Contributing ticket ids — the whole point of the cluster: which tickets
      // does a human open to see this failure pattern?
      expect([...(missingTests!.tickets as string[])].sort()).toEqual(["AI-3001", "AI-3002", "AI-3003"]);

      const style = clusters.find(
        (c) => c.workflow === "dev-impl" && c.step === "code-review" && c.reasonCode === "style",
      );
      expect(style).toBeDefined();
      expect(style!.count).toBe(1);
      expect(style!.exceedsThreshold).toBe(false);
      expect(style!.tickets).toEqual(["AI-3004"]);
    });

    test("clusters are backed by ObservationStore.metrics(), which carries the contributing ticket ids", () => {
      seedObservations();

      // AC2.1 says the endpoint is "backed by ObservationStore.metrics()". The
      // ticket ids must therefore come out of metrics() itself, not be stitched
      // on by the route handler with a second query.
      const rollup = appState.observationStore.metrics({ threshold: 3 });
      const missingTests = rollup.items.find((i) => i.reasonCode === "missing-tests");

      expect(missingTests).toBeDefined();
      expect(missingTests!.count).toBe(3);
      expect(missingTests!.exceedsThreshold).toBe(true);
      expect([...((missingTests as unknown as { tickets: string[] }).tickets ?? [])].sort()).toEqual([
        "AI-3001",
        "AI-3002",
        "AI-3003",
      ]);
    });
  });

  // ── AC2.2 ────────────────────────────────────────────────────────────────
  describe("AC2.2: excluded event classes and stale-digest noise", () => {
    /**
     * Every seeded row carries enrichment columns, so an excluded row would be
     * clustered if the exclusion were missing. That is what makes this a real
     * negative test rather than a coincidence of AC2.5's enrichment filter.
     */
    function seedOperationalEvents(): void {
      const enriched = { workflowState: "code-review", plane: "connector", agent: "igor" } as const;
      const append = (outcome: string, wakeId: string) =>
        appState.operationalEventStore.append({
          ...enriched,
          outcome: outcome as OperationalEventOutcome,
          wakeId,
        });

      // Signal: a genuine operational failure that SHOULD cluster.
      append("delivery-failed", "wake-real-1");
      append("delivery-failed", "wake-real-2");

      // AC2.2 named exclusions.
      append("signature-rejected", "wake-sig-1");
      append("signature-rejected", "wake-sig-2");
      append("signature-rejected", "wake-sig-3");
      append("duplicate", "wake-dup-1");
      append("duplicate", "wake-dup-2");

      // AC2.2 stale-digest noise from old connector bugs.
      append("dropped-stale", "wake-stale-1");
      append("dropped-stale", "wake-stale-2");
      append("suppressed-duplicate", "wake-supp-1");
      append("suppressed-duplicate", "wake-supp-2");
    }

    test("signature-rejected and duplicate event classes are never clustered", async () => {
      seedOperationalEvents();

      const res = await adminGet(appState.app, `${CLUSTERS}?kind=operational-events&threshold=2`);
      expect(res.status).toBe(200);

      const clusters = res.body.clusters as Array<{ outcome: string; count: number; exceedsThreshold: boolean }>;
      const clusteredOutcomes = clusters.map((c) => c.outcome);

      for (const excluded of EXCLUDED_EVENT_CLASSES) {
        expect(clusteredOutcomes).not.toContain(excluded);
      }

      // The signal survives the filter — proving exclusion is targeted, not a
      // blanket empty response.
      const deliveryFailed = clusters.find((c) => c.outcome === "delivery-failed");
      expect(deliveryFailed).toBeDefined();
      expect(deliveryFailed!.count).toBe(2);
      expect(deliveryFailed!.exceedsThreshold).toBe(true);
    });

    test("stale-digest noise (dropped-stale, suppressed-duplicate) is filtered, not clustered", async () => {
      seedOperationalEvents();

      const res = await adminGet(appState.app, `${CLUSTERS}?kind=operational-events&threshold=2`);
      expect(res.status).toBe(200);

      const clusteredOutcomes = (res.body.clusters as Array<{ outcome: string }>).map((c) => c.outcome);
      for (const noise of STALE_DIGEST_NOISE) {
        expect(clusteredOutcomes).not.toContain(noise);
      }
    });
  });

  // ── AC2.3 ────────────────────────────────────────────────────────────────
  describe("AC2.3: alert-store (dead-letter) clusters", () => {
    test("clusters alert rows by (source, dedupKey, agent) via the same API", async () => {
      // suppressWindowMs=0 → each record() inserts a fresh burst row, so the
      // cluster must SUM across rows sharing the dedup identity.
      alertStore.record(
        { severity: "critical", source: "dispatch", title: "wake failed", agent: "igor", ticket: "AI-3010", dedupKey: "dk-dispatch-igor" },
        0,
      );
      alertStore.record(
        { severity: "critical", source: "dispatch", title: "wake failed", agent: "igor", ticket: "AI-3011", dedupKey: "dk-dispatch-igor" },
        0,
      );
      alertStore.record(
        { severity: "warning", source: "routing", title: "no route", agent: "sage", ticket: "AI-3012", dedupKey: "dk-routing-sage" },
        0,
      );

      const res = await adminGet(appState.app, `${CLUSTERS}?kind=alerts&threshold=2`);
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("alerts");

      const clusters = res.body.clusters as Array<Record<string, unknown>>;

      const dispatchCluster = clusters.find(
        (c) => c.source === "dispatch" && c.dedupKey === "dk-dispatch-igor" && c.agent === "igor",
      );
      expect(dispatchCluster).toBeDefined();
      expect(dispatchCluster!.count).toBe(2);
      expect(dispatchCluster!.exceedsThreshold).toBe(true);

      const routingCluster = clusters.find(
        (c) => c.source === "routing" && c.dedupKey === "dk-routing-sage" && c.agent === "sage",
      );
      expect(routingCluster).toBeDefined();
      expect(routingCluster!.count).toBe(1);
      expect(routingCluster!.exceedsThreshold).toBe(false);
    });
  });

  // ── AC2.4 (on-demand half) ───────────────────────────────────────────────
  describe("AC2.4: clustering is computed on demand", () => {
    test("a row written after boot is reflected in the very next request (no precomputed cache)", async () => {
      const before = await adminGet(appState.app, `${CLUSTERS}?kind=observations&threshold=1`);
      expect(before.status).toBe(200);
      expect(before.body.clusters).toEqual([]);

      // Nothing scheduled has run in this process — if the endpoint served a
      // cron-populated snapshot instead of querying live, this row would be
      // invisible.
      appState.observationStore.append({
        ticket: "AI-3020",
        workflow: "dev-impl",
        step: "ac-validate",
        fromBody: "igor",
        reviewerBody: "cra",
        reasonCode: "ac-mismatch",
      });

      const after = await adminGet(appState.app, `${CLUSTERS}?kind=observations&threshold=1`);
      expect(after.status).toBe(200);
      const cluster = (after.body.clusters as Array<Record<string, unknown>>).find(
        (c) => c.step === "ac-validate" && c.reasonCode === "ac-mismatch",
      );
      expect(cluster).toBeDefined();
      expect(cluster!.count).toBe(1);
      expect(cluster!.tickets).toEqual(["AI-3020"]);
    });
  });

  // ── AC2.5 ────────────────────────────────────────────────────────────────
  describe("AC2.5: forward-only enrichment columns, no claim over historical rows", () => {
    /** 5 pre-enrichment rows (NULL workflow_state/plane/wake_id) + 2 enriched rows. */
    function seedMixedEnrichment(): void {
      for (let i = 0; i < 5; i++) {
        // Pre-enrichment historical row: written before AI-1799 added the columns.
        appState.operationalEventStore.append({
          outcome: "delivery-failed" as OperationalEventOutcome,
          agent: "igor",
        });
      }
      for (let i = 0; i < 2; i++) {
        appState.operationalEventStore.append({
          outcome: "delivery-failed" as OperationalEventOutcome,
          agent: "igor",
          workflowState: "code-review",
          plane: "connector",
          wakeId: `wake-post-${i}`,
        });
      }
    }

    test("pre-enrichment rows contribute nothing to cluster counts", async () => {
      seedMixedEnrichment();

      const res = await adminGet(appState.app, `${CLUSTERS}?kind=operational-events&threshold=2`);
      expect(res.status).toBe(200);

      const clusters = res.body.clusters as Array<{ outcome: string; count: number }>;
      const deliveryFailed = clusters.find((c) => c.outcome === "delivery-failed");
      expect(deliveryFailed).toBeDefined();
      // 2 enriched rows — NOT 7. The 5 historical rows are outside the claim.
      expect(deliveryFailed!.count).toBe(2);
    });

    test("every cluster is keyed on the enrichment columns (workflowState, plane) and carries wake ids", async () => {
      seedMixedEnrichment();

      const res = await adminGet(appState.app, `${CLUSTERS}?kind=operational-events&threshold=2`);
      expect(res.status).toBe(200);

      const clusters = res.body.clusters as Array<Record<string, unknown>>;
      expect(clusters.length).toBeGreaterThan(0);
      for (const cluster of clusters) {
        expect(cluster.workflowState).not.toBeNull();
        expect(cluster.workflowState).toBeDefined();
        expect(cluster.plane).not.toBeNull();
        expect(cluster.plane).toBeDefined();
        expect(Array.isArray(cluster.wakeIds)).toBe(true);
      }

      const deliveryFailed = clusters.find((c) => c.outcome === "delivery-failed")!;
      expect([...(deliveryFailed.wakeIds as string[])].sort()).toEqual(["wake-post-0", "wake-post-1"]);
    });

    test("the response states how many pre-enrichment rows were excluded, rather than silently dropping them", async () => {
      seedMixedEnrichment();

      const res = await adminGet(appState.app, `${CLUSTERS}?kind=operational-events&threshold=2`);
      expect(res.status).toBe(200);

      // "Makes no claim over pre-enrichment historical rows" has to be visible
      // to the caller — otherwise a shrinking cluster count is indistinguishable
      // from a real drop in failures.
      expect(res.body.excludedPreEnrichmentRows).toBe(5);
    });
  });
});
