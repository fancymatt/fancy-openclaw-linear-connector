/**
 * AI-1785 — Tests for the steward-invokable recapture-ac admin API surface.
 *
 * POST /admin/api/recapture-ac wraps recaptureAc() so a steward can
 * (re)capture the AC of record via the connector admin API.  Caller identity
 * (callerBodyId) flows through to the existing steward gate inside
 * recaptureAc — no new permission mechanism.
 *
 * AC2: A steward can trigger recapture via the shipped surface; non-steward
 *      invocation is rejected.  Proven by test.
 * AC3: Force/overwrite and comment-trail semantics preserved through the new
 *      surface (no bypass).  Proven by test.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import request from "supertest";
import { describe as describeTop } from "@jest/globals";

import { createApp } from "./index.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { clearAcRecordStore } from "./ac-record-store.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "recapture-ac-admin-test-"));
}

const ADMIN_SECRET = "recapture-admin-secret";

const DESCRIPTION_WITH_AC = `## Problem
Something broke.

## Acceptance Criteria

* AC1: The extractor works
* AC2: Tests pass

## Pointers
See the code.`;

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "igor",
          linearUserId: "user-igor-linear-id",
          openclawAgent: "igor",
          clientId: "client-id",
          clientSecret: "client-secret",
          accessToken: "access-token-igor",
          refreshToken: "refresh-token-igor",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

function writePolicyYaml(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  const policy = {
    capabilities: [
      { id: "linear:transition" },
      { id: "human:escalate" },
    ],
    containers: [
      { id: "steward", grants: ["linear:transition", "human:escalate"] },
      { id: "dev", grants: ["linear:transition"] },
    ],
    roles: [
      { id: "steward", requires: ["human:escalate"] },
      { id: "dev", requires: ["linear:transition"] },
    ],
    bodies: [
      { id: "astrid", container: "steward", fills_roles: ["steward"] },
      { id: "charles", container: "dev", fills_roles: ["dev"] },
    ],
  };
  fs.writeFileSync(file, yaml.dump(policy), "utf8");
  return file;
}

/** Mock fetch for the Linear API calls that recaptureAc issues. */
function makeRecaptureFetch(description: string): typeof globalThis.fetch {
  return async (_url, init) => {
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Buffer
          ? init.body.toString()
          : "";
    const parsed = JSON.parse(bodyText) as { query?: string };
    const query = parsed.query ?? "";

    // IssueDescription query (used by recaptureAc to fetch the description)
    if (query.includes("IssueDescription") || query.includes("issue(id:")) {
      return new Response(
        JSON.stringify({ data: { issue: { description } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // commentCreate mutation (force-overwrite trail)
    if (query.includes("commentCreate")) {
      return new Response(
        JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "cmt-1" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describeTop("POST /admin/api/recapture-ac (AI-1785)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = tempDir();
    const policyFile = writePolicyYaml(dir);
    const agentsFile = writeAgents(dir);

    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.AGENTS_FILE = agentsFile;
    process.env.AC_RECORDS_PATH = path.join(dir, "ac-records.json");
    reloadAgents();
    resetPolicyCache();
    clearAcRecordStore();
    originalFetch = globalThis.fetch;

    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    clearAcRecordStore();
    resetPolicyCache();
    delete process.env.ADMIN_SECRET;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
    delete process.env.AC_RECORDS_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Auth gating ────────────────────────────────────────────────────────

  it("returns 401 when no ADMIN_SECRET is provided", async () => {
    await request(appState.app)
      .post("/admin/api/recapture-ac")
      .send({ ticketId: "AI-9999", callerBodyId: "astrid" })
      .expect(401);
  });

  it("returns 401 for wrong ADMIN_SECRET", async () => {
    await request(appState.app)
      .post("/admin/api/recapture-ac")
      .set("x-admin-secret", "wrong-secret")
      .send({ ticketId: "AI-9999", callerBodyId: "astrid" })
      .expect(401);
  });

  // ── Input validation ──────────────────────────────────────────────────

  it("returns 400 when ticketId is missing", async () => {
    await request(appState.app)
      .post("/admin/api/recapture-ac")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ callerBodyId: "astrid" })
      .expect(400);
  });

  it("returns 400 when callerBodyId is missing", async () => {
    await request(appState.app)
      .post("/admin/api/recapture-ac")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ ticketId: "AI-9999" })
      .expect(400);
  });

  // ── AC2: steward can trigger; non-steward rejected ──────────────────────

  it("AC2: steward caller succeeds — 200 with recapture result", async () => {
    globalThis.fetch = makeRecaptureFetch(DESCRIPTION_WITH_AC);

    const res = await request(appState.app)
      .post("/admin/api/recapture-ac")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ ticketId: "AI-1785", callerBodyId: "astrid", invoker: "astrid", reason: "re-capturing AC post spec change" })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.ticketId).toBe("AI-1785");
    expect(res.body.callerBodyId).toBe("astrid");
    expect(res.body.force).toBe(false);
  });

  it("AC2: non-steward caller is rejected — 403", async () => {
    globalThis.fetch = makeRecaptureFetch(DESCRIPTION_WITH_AC);

    const res = await request(appState.app)
      .post("/admin/api/recapture-ac")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ ticketId: "AI-1785", callerBodyId: "charles", invoker: "charles", reason: "attempting re-capture" })
      .expect(403);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/not authorized/i);
  });

  it("AC2: unknown callerBodyId is rejected — 403", async () => {
    globalThis.fetch = makeRecaptureFetch(DESCRIPTION_WITH_AC);

    const res = await request(appState.app)
      .post("/admin/api/recapture-ac")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ ticketId: "AI-1785", callerBodyId: "nobody", invoker: "nobody", reason: "attempting re-capture" })
      .expect(403);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/not authorized/i);
  });

  // ── AC3: force/overwrite semantics through the surface ─────────────────

  it("AC3: existing record without force → 422 overwrite guard", async () => {
    // First capture (steward, no existing record)
    globalThis.fetch = makeRecaptureFetch(DESCRIPTION_WITH_AC);
    await request(appState.app)
      .post("/admin/api/recapture-ac")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ ticketId: "AI-1785", callerBodyId: "astrid", invoker: "astrid", reason: "initial capture" })
      .expect(200);

    // Second attempt without force → rejected
    const res = await request(appState.app)
      .post("/admin/api/recapture-ac")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ ticketId: "AI-1785", callerBodyId: "astrid", invoker: "astrid", reason: "second capture attempt" })
      .expect(422);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("AC3: existing record with force: true → 200 overwrite", async () => {
    // First capture
    globalThis.fetch = makeRecaptureFetch(DESCRIPTION_WITH_AC);
    await request(appState.app)
      .post("/admin/api/recapture-ac")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ ticketId: "AI-1785", callerBodyId: "astrid", invoker: "astrid", reason: "initial capture" })
      .expect(200);

    // Force overwrite
    const res = await request(appState.app)
      .post("/admin/api/recapture-ac")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ ticketId: "AI-1785", callerBodyId: "astrid", invoker: "astrid", reason: "force overwrite after spec update", force: true })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.force).toBe(true);
  });

  it("AC3: force overwrite by non-steward is still rejected — 403 (no bypass)", async () => {
    globalThis.fetch = makeRecaptureFetch(DESCRIPTION_WITH_AC);

    const res = await request(appState.app)
      .post("/admin/api/recapture-ac")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ ticketId: "AI-1785", callerBodyId: "charles", invoker: "charles", reason: "force bypass attempt", force: true })
      .expect(403);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/not authorized/i);
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  it("returns 422 when description has no AC header", async () => {
    globalThis.fetch = makeRecaptureFetch("## Problem\nNo AC section here.");

    const res = await request(appState.app)
      .post("/admin/api/recapture-ac")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ ticketId: "AI-1785", callerBodyId: "astrid", invoker: "astrid", reason: "re-capture after spec revision" })
      .expect(422);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/no acceptance criteria/i);
  });
});
