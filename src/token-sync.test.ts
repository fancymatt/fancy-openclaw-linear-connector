/**
 * Tests for the token-sync endpoint.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import express from "express";
import { createTokenSyncRouter } from "./token-sync.js";
import { reloadAgents } from "./agents.js";

function makeTempAgentsFile(agents: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-sync-test-"));
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({ agents }));
  return file;
}

const TEST_AGENTS = [
  { name: "charles", linearUserId: "u1", clientId: "c1", clientSecret: "s1", accessToken: "tok_charles_access_12345", refreshToken: "ref_charles" },
  { name: "sakura", linearUserId: "u2", clientId: "c2", clientSecret: "s2", accessToken: "tok_sakura_access_67890", refreshToken: "ref_sakura" },
];

function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(createTokenSyncRouter());
  return app;
}

describe("GET /tokens/:agent", () => {
  let agentsFile: string;
  let app: express.Application;

  beforeAll(() => {
    agentsFile = makeTempAgentsFile(TEST_AGENTS);
    process.env.AGENTS_FILE = agentsFile;
    process.env.TOKEN_SYNC_SECRET = "test-secret-123";
    reloadAgents();
    app = createApp();
  });

  afterAll(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.TOKEN_SYNC_SECRET;
    fs.rmSync(path.dirname(agentsFile), { recursive: true, force: true });
  });

  it("returns 401 when no Authorization header", async () => {
    const res = await request(app).get("/tokens/charles");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 401 on wrong bearer token", async () => {
    const res = await request(app)
      .get("/tokens/charles")
      .set("Authorization", "Bearer wrong-secret");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 404 for unknown agent", async () => {
    const res = await request(app)
      .get("/tokens/nonexistent")
      .set("Authorization", "Bearer test-secret-123");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
  });

  it("returns 200 with correct shape for known agent", async () => {
    const res = await request(app)
      .get("/tokens/charles")
      .set("Authorization", "Bearer test-secret-123");
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe("tok_charles_access_12345");
    expect(res.body.refresh_token).toBe("ref_charles");
    expect(res.body.scope).toBe("read");
    expect(res.body.updated_at).toBeDefined();
    // Should be a valid ISO date
    expect(new Date(res.body.updated_at).getTime()).not.toBeNaN();
  });

  it("returns correct tokens per agent", async () => {
    const res = await request(app)
      .get("/tokens/sakura")
      .set("Authorization", "Bearer test-secret-123");
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe("tok_sakura_access_67890");
  });
});
