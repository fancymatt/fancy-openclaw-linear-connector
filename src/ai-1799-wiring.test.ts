/**
 * AI-1799 AC5 — Wiring assertions: the mirror and enrichment must be wired
 * into the real entry points (src/index.ts / webhook path / proxy path),
 * not just exported from a module.
 *
 * Background (from the ticket): "behavior verified through the real entry
 * points (not module-only unit tests) — wiring must be asserted in
 * src/index.ts/webhook path per the AI-1775 round-1 lesson."
 *
 * The AI-1775 round-1 lesson: the original PR exported
 * registerBootstrapReconciliationCron but never called it from index.ts.
 * 13 unit tests passed because they invoked the module directly — the gap
 * between "code merged" and "deployed artifact satisfies AC" was invisible.
 * This test closes that gap at CI time for AI-1799 by reading index.ts
 * source and asserting the wiring is present.
 *
 * Pattern follows bootstrap-reconciliation-wiring.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INDEX_TS = fs.readFileSync(
  path.resolve(__dirname, "index.ts"),
  "utf8",
);

describe("AI-1799 AC5: enrolled-tickets mirror is wired in index.ts", () => {
  it("imports EnrolledTicketsStore from the store module", () => {
    expect(
      INDEX_TS.includes(
        'import { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js"',
      ),
    ).toBe(true);
  });

  it("instantiates the mirror store in createApp with a configurable db path", () => {
    expect(INDEX_TS.includes("new EnrolledTicketsStore")).toBe(true);
    // Test override path must be accepted (same pattern as OperationalEventStore)
    expect(INDEX_TS.includes("enrolledTicketsDbPath")).toBe(true);
  });

  it("exposes the mirror store on the createApp return object", () => {
    // The createApp function returns an object — the mirror must be on it
    // so the admin router and tests can access it.
    expect(INDEX_TS.includes("enrolledTicketsStore")).toBe(true);
  });

  it("passes the mirror store to the webhook router (bootstrap/terminal writes)", () => {
    // createWebhookRouter must receive the enrolledTicketsStore so the
    // bootstrap path and terminal-prune path can write to the mirror.
    // We check that enrolledTicketsStore appears near createWebhookRouter.
    expect(INDEX_TS.includes("createWebhookRouter")).toBe(true);
    // The mirror store variable name should appear in the createWebhookRouter
    // call block — verify it's referenced in the file after the router call.
    const routerCallIdx = INDEX_TS.indexOf("createWebhookRouter(");
    const routerCallEnd = INDEX_TS.indexOf("));", routerCallIdx);
    const routerCallBlock = INDEX_TS.slice(routerCallIdx, routerCallEnd);
    expect(routerCallBlock.includes("enrolledTicketsStore")).toBe(true);
  });
});

describe("AI-1799 AC5: event enrichment is wired in the webhook path", () => {
  it("the webhook source mints a wake_id at route time (grep for wakeId minting)", () => {
    // The webhook handler must mint a wake_id correlation id at the point
    // a dispatch cycle begins (route time) and carry it through.
    const WEBHOOK_TS = fs.readFileSync(
      path.resolve(__dirname, "webhook", "index.ts"),
      "utf8",
    );
    // Look for wake_id minting in the dispatch/route section
    expect(WEBHOOK_TS.includes("wakeId")).toBe(true);
  });

  it("the operational event store schema includes workflow_state, plane, and wake_id columns", () => {
    const STORE_TS = fs.readFileSync(
      path.resolve(__dirname, "store", "operational-event-store.ts"),
      "utf8",
    );
    // The store must have these columns in its schema
    expect(STORE_TS.includes("workflow_state")).toBe(true);
    expect(STORE_TS.includes("plane")).toBe(true);
    expect(STORE_TS.includes("wake_id")).toBe(true);
  });
});

describe("AI-1799 AC5: mirror is wired into the proxy transition path", () => {
  it("workflow-gate.ts references the enrolled-tickets store (transitions write to mirror)", () => {
    const GATE_TS = fs.readFileSync(
      path.resolve(__dirname, "workflow-gate.ts"),
      "utf8",
    );
    // applyStateTransition must write to the mirror — either via import
    // or dependency injection.  Check for the store reference.
    expect(
      GATE_TS.includes("enrolledTicketsStore") ||
      GATE_TS.includes("EnrolledTicketsStore") ||
      GATE_TS.includes("enrolled-tickets-store"),
    ).toBe(true);
  });

  it("workflow-bootstrap.ts references the enrolled-tickets store (enrollment writes to mirror)", () => {
    const BOOTSTRAP_TS = fs.readFileSync(
      path.resolve(__dirname, "workflow-bootstrap.ts"),
      "utf8",
    );
    expect(
      BOOTSTRAP_TS.includes("enrolledTicketsStore") ||
      BOOTSTRAP_TS.includes("EnrolledTicketsStore") ||
      BOOTSTRAP_TS.includes("enrolled-tickets-store"),
    ).toBe(true);
  });
});

describe("AI-1799 AC5: Read API (/api/board) is wired in the admin router", () => {
  it("admin.ts exposes a /api/board endpoint", () => {
    const ADMIN_TS = fs.readFileSync(
      path.resolve(__dirname, "admin.ts"),
      "utf8",
    );
    expect(ADMIN_TS.includes('"/api/board"')).toBe(true);
  });
});
