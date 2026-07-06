/**
 * AI-1849 — Connector docs endpoint + per-agent capability rendering.
 *
 * Pillar 2 D2: serve instance-config docs (policy/, workflows/, capability
 * renderings) read-only to authenticated agents via lpx proxy token. The
 * `linear guidance <topic>` CLI verb fetches docs through this endpoint.
 *
 * AC coverage (mapped per assertion):
 *  AC1 — `linear guidance` (topic list) and `linear guidance <topic>` (body)
 *         reachable with lpx proxy token; no extra env required.
 *  AC2 — `linear guidance capabilities` returns the REQUESTING agent's own
 *         capability set; two agents → different correct output.
 *  AC3 — Docs served read-only; no write surface; admin secret NOT required;
 *         unauthenticated requests rejected (401).
 *  AC4 — Unknown topic → helpful error listing valid topics; no stack trace.
 *  AC5 — Endpoint registered at server bootstrap (createApp()); liveness
 *         observable via /health `docs` field.
 */

import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-1849-docs-test-"));
}

/** Minimal agents.json with two agents that have distinct proxy tokens. */
function writeAgentsWithProxyTokens(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "igor",
          linearUserId: "user-igor-12345678",
          openclawAgent: "igor",
          clientId: "client-id-igor",
          clientSecret: "client-secret-igor",
          accessToken: "access-token-igor",
          refreshToken: "refresh-token-igor",
          host: "local",
          proxyToken: "lpx_igor_test_abc123",
        },
        {
          name: "sage",
          linearUserId: "user-sage-12345678",
          openclawAgent: "sage",
          clientId: "client-id-sage",
          clientSecret: "client-secret-sage",
          accessToken: "access-token-sage",
          refreshToken: "refresh-token-sage",
          host: "local",
          proxyToken: "lpx_sage_test_xyz789",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

/** Write a minimal capability-policy.yaml with distinct capabilities per container. */
function writeCapabilityPolicy(dir: string): string {
  const policyDir = path.join(dir, "config");
  fs.mkdirSync(policyDir, { recursive: true });
  const file = path.join(policyDir, "capability-policy.yaml");
  fs.writeFileSync(
    file,
    `
capabilities:
  - id: linear:transition
    description: "Make Linear workflow transitions"
  - id: repo:write
    description: "Push commits to GitHub"
  - id: deploy:execute
    description: "Execute deployments"
  - id: human:escalate
    description: "Escalate to human review"
containers:
  - id: dev-backend
    grants: [linear:transition, repo:write]
  - id: dev-frontend
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
roles:
  - id: test-author
    requires: [repo:write]
bodies:
  - id: igor
    container: dev-backend
    fills_roles: []
  - id: sage
    container: dev-frontend
    fills_roles: []
`.trim(),
    "utf8",
  );
  return file;
}

/** Write a minimal canon file under policy/. */
function writeCanonFile(dir: string): string {
  const policyDir = path.join(dir, "policy");
  fs.mkdirSync(policyDir, { recursive: true });
  const file = path.join(policyDir, "universal.md");
  fs.writeFileSync(
    file,
    `---\nversion: v1\n---\n\n1. Read the ticket fully before acting.\n2. Comment discipline: post one substantive comment.\n`,
    "utf8",
  );
  return file;
}

/** Write a deploy doc under policy/. */
function writeDeployDoc(dir: string): string {
  const policyDir = path.join(dir, "policy");
  fs.mkdirSync(policyDir, { recursive: true });
  const file = path.join(policyDir, "deploy.md");
  fs.writeFileSync(file, `# Deploy Playbook\n\nSteps for deploying the connector.\n`, "utf8");
  return file;
}

// ── Shared test state ──────────────────────────────────────────────────────

let dir: string;
let webDist: string;
let capabilityPolicyFile: string;
let appState: ReturnType<typeof createApp>;
const ADMIN_SECRET = "admin-secret-ai1849";
const IGOR_PROXY_TOKEN = "lpx_igor_test_abc123";
const SAGE_PROXY_TOKEN = "lpx_sage_test_xyz789";

beforeEach(() => {
  dir = tempDir();
  webDist = path.join(dir, "web-dist");
  fs.mkdirSync(webDist, { recursive: true });
  fs.writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>Test</title>", "utf8");

  process.env.AGENTS_FILE = writeAgentsWithProxyTokens(dir);
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  process.env.ADMIN_WEB_DIST = webDist;
  process.env.LINEAR_CONNECTOR_CONFIG_DIR = dir;
  capabilityPolicyFile = writeCapabilityPolicy(dir);
  process.env.CAPABILITY_POLICY_PATH = capabilityPolicyFile;
  writeCanonFile(dir);
  writeDeployDoc(dir);

  reloadAgents();
  appState = createApp({
    bagDbPath: path.join(dir, "pending-bag.db"),
    agentQueueDbPath: path.join(dir, "agent-queue.db"),
    operationalEventsDbPath: path.join(dir, "operational-events.db"),
  });
});

afterEach(() => {
  appState.bag.close();
  appState.sessionTracker.close();
  appState.agentQueue.close();
  appState.operationalEventStore.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENTS_FILE;
  delete process.env.ADMIN_SECRET;
  delete process.env.ADMIN_WEB_DIST;
  delete process.env.LINEAR_CONNECTOR_CONFIG_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
});

// ── AC3: auth — unauthenticated requests rejected ─────────────────────────

describe("AC3: auth", () => {
  test("GET /docs without authorization → 401", async () => {
    const res = await request(appState.app).get("/docs");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  test("GET /docs/capabilities without authorization → 401", async () => {
    const res = await request(appState.app).get("/docs/capabilities");
    expect(res.status).toBe(401);
  });

  test("GET /docs/canon without authorization → 401", async () => {
    const res = await request(appState.app).get("/docs/canon");
    expect(res.status).toBe(401);
  });

  test("admin secret alone does NOT grant access to /docs (proxy token required)", async () => {
    const res = await request(appState.app)
      .get("/docs")
      .set("x-admin-secret", ADMIN_SECRET);
    // Admin secret is for the admin console, not the docs endpoint.
    // Agents use their lpx proxy token — not the admin secret.
    expect(res.status).toBe(401);
  });

  test("valid lpx proxy token grants access to GET /docs", async () => {
    const res = await request(appState.app)
      .get("/docs")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`);
    expect(res.status).toBe(200);
  });
});

// ── AC3: no write surface ─────────────────────────────────────────────────

describe("AC3: read-only — no write surface", () => {
  test("POST /docs is not allowed", async () => {
    const res = await request(appState.app)
      .post("/docs")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`)
      .send({ topic: "canon" });
    expect([404, 405]).toContain(res.status);
  });

  test("PUT /docs/canon is not allowed", async () => {
    const res = await request(appState.app)
      .put("/docs/canon")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`)
      .send("overwrite attempt");
    expect([404, 405]).toContain(res.status);
  });

  test("DELETE /docs/canon is not allowed", async () => {
    const res = await request(appState.app)
      .delete("/docs/canon")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`);
    expect([404, 405]).toContain(res.status);
  });
});

// ── AC1: topic listing ────────────────────────────────────────────────────

describe("AC1: GET /docs — topic listing", () => {
  test("returns a list of available topics with descriptions", async () => {
    const res = await request(appState.app)
      .get("/docs")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      topics: expect.arrayContaining([
        expect.objectContaining({ id: "capabilities", description: expect.any(String) }),
        expect.objectContaining({ id: "canon", description: expect.any(String) }),
        expect.objectContaining({ id: "deploy", description: expect.any(String) }),
      ]),
    });
  });

  test("topic list includes at least capabilities, canon, deploy", async () => {
    const res = await request(appState.app)
      .get("/docs")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`);
    const ids = (res.body.topics as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain("capabilities");
    expect(ids).toContain("canon");
    expect(ids).toContain("deploy");
  });

  test("topic list is accessible to sage (any valid lpx token)", async () => {
    const res = await request(appState.app)
      .get("/docs")
      .set("Authorization", `Bearer ${SAGE_PROXY_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.topics).toBeDefined();
  });
});

// ── AC1: topic fetch ──────────────────────────────────────────────────────

describe("AC1: GET /docs/:topic — doc body fetch", () => {
  test("GET /docs/canon returns canon file content", async () => {
    const res = await request(appState.app)
      .get("/docs/canon")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      topic: "canon",
      body: expect.stringContaining("Read the ticket fully before acting"),
    });
  });

  test("GET /docs/deploy returns deploy playbook content", async () => {
    const res = await request(appState.app)
      .get("/docs/deploy")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      topic: "deploy",
      body: expect.stringContaining("Deploy Playbook"),
    });
  });

  test("doc response includes topic id and body fields", async () => {
    const res = await request(appState.app)
      .get("/docs/canon")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`);
    expect(res.body).toHaveProperty("topic");
    expect(res.body).toHaveProperty("body");
    expect(typeof res.body.body).toBe("string");
    expect(res.body.body.length).toBeGreaterThan(0);
  });
});

// ── AC4: unknown topic → helpful error ───────────────────────────────────

describe("AC4: unknown topic → helpful error", () => {
  test("unknown topic returns 404 with helpful error listing valid topics", async () => {
    const res = await request(appState.app)
      .get("/docs/no-such-topic-xyz")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: expect.any(String),
      validTopics: expect.arrayContaining(["capabilities", "canon", "deploy"]),
    });
  });

  test("unknown topic error body does not contain a stack trace", async () => {
    const res = await request(appState.app)
      .get("/docs/no-such-topic-xyz")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toMatch(/Error:/);
    expect(bodyStr).not.toMatch(/at Object\./);
    expect(bodyStr).not.toMatch(/\.ts:\d+/);
  });
});

// ── AC2: per-agent capability rendering ───────────────────────────────────

describe("AC2: GET /docs/capabilities — per-agent scoped rendering", () => {
  test("igor gets capabilities matching dev-backend container grants", async () => {
    const res = await request(appState.app)
      .get("/docs/capabilities")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      topic: "capabilities",
      agent: "igor",
      container: "dev-backend",
      capabilities: expect.arrayContaining([
        expect.objectContaining({ id: "linear:transition" }),
        expect.objectContaining({ id: "repo:write" }),
      ]),
    });
  });

  test("sage gets capabilities matching dev-frontend container grants (different from igor)", async () => {
    const res = await request(appState.app)
      .get("/docs/capabilities")
      .set("Authorization", `Bearer ${SAGE_PROXY_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      topic: "capabilities",
      agent: "sage",
      container: "dev-frontend",
      capabilities: expect.arrayContaining([
        expect.objectContaining({ id: "linear:transition" }),
      ]),
    });
    // sage's container does NOT grant repo:write
    const ids = (res.body.capabilities as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain("repo:write");
  });

  test("igor and sage get genuinely different capability sets", async () => {
    const [igorRes, sageRes] = await Promise.all([
      request(appState.app)
        .get("/docs/capabilities")
        .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`),
      request(appState.app)
        .get("/docs/capabilities")
        .set("Authorization", `Bearer ${SAGE_PROXY_TOKEN}`),
    ]);

    expect(igorRes.status).toBe(200);
    expect(sageRes.status).toBe(200);

    const igorIds = (igorRes.body.capabilities as Array<{ id: string }>).map((c) => c.id).sort();
    const sageIds = (sageRes.body.capabilities as Array<{ id: string }>).map((c) => c.id).sort();
    expect(igorIds).not.toEqual(sageIds);
  });

  test("capabilities response includes a human-readable body text for CLI display", async () => {
    const res = await request(appState.app)
      .get("/docs/capabilities")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("body");
    expect(typeof res.body.body).toBe("string");
    expect(res.body.body).toContain("igor");
    expect(res.body.body).toContain("linear:transition");
  });

  test("agent with no policy body entry gets an empty capability set (not a 500)", async () => {
    // Write an agents file with a third agent who has no body in capability-policy.yaml
    const file = process.env.AGENTS_FILE!;
    const existing = JSON.parse(fs.readFileSync(file, "utf8"));
    existing.agents.push({
      name: "nobody",
      linearUserId: "user-nobody-000",
      openclawAgent: "nobody",
      clientId: "c",
      clientSecret: "s",
      accessToken: "a",
      refreshToken: "r",
      host: "local",
      proxyToken: "lpx_nobody_test_zzz",
    });
    fs.writeFileSync(file, JSON.stringify(existing), "utf8");
    reloadAgents();

    const res = await request(appState.app)
      .get("/docs/capabilities")
      .set("Authorization", "Bearer lpx_nobody_test_zzz");
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.capabilities)).toBe(true);
      expect(res.body.capabilities).toHaveLength(0);
    }
    // Must not 500
    expect(res.status).not.toBe(500);
  });
});

// ── AC5: bootstrap registration ───────────────────────────────────────────

describe("AC5: bootstrap registration", () => {
  test("createApp() registers /docs — GET /docs is not a 404", async () => {
    // The endpoint must be wired up in createApp(), reachable from the
    // production entry point. A 404 means the route was never registered.
    const res = await request(appState.app)
      .get("/docs")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`);
    // Any 2xx or 401 proves the route is registered. 404 = not registered.
    expect(res.status).not.toBe(404);
  });

  test("/health exposes docs liveness field", async () => {
    const res = await request(appState.app).get("/health");
    // The /health response must include a `docs` field showing the endpoint
    // is active, analogous to the universalCanon liveness field from D1.
    expect(res.body).toHaveProperty("docs");
    expect(res.body.docs).toMatchObject({
      registered: true,
    });
  });
});

// ── AC1: works with lpx token only — no extra env ────────────────────────

describe("AC1: lpx token is the only auth required", () => {
  test("requesting /docs requires only the Bearer lpx token (no x-admin-secret, no custom headers)", async () => {
    // Simulate a clean-session agent: presents only the Authorization header.
    const res = await request(appState.app)
      .get("/docs")
      .set("Authorization", `Bearer ${IGOR_PROXY_TOKEN}`);
    // No other headers set — this must still work.
    expect(res.status).toBe(200);
  });

  test("an invalid/unknown token returns 401, not 403 or 500", async () => {
    const res = await request(appState.app)
      .get("/docs")
      .set("Authorization", "Bearer lpx_not_a_real_token_ever");
    expect(res.status).toBe(401);
  });
});
