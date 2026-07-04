/**
 * AI-1767 — Tests for the upload proxy endpoint (/proxy/upload).
 *
 * Verifies that the connector correctly resolves proxy tokens, fetches from
 * uploads.linear.app with real credentials, and streams bytes back.
 */

import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { jest } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";

/**
 * Minimal agents.json with a broker (proxy-token) agent.
 * The proxyToken is what the agent presents; accessToken is the real Linear
 * token the connector swaps in.
 */
function writeBrokerAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "igor",
          linearUserId: "u1",
          openclawAgent: "igor",
          accessToken: "lin_real_oauth_token",
          refreshToken: "r1",
          proxyToken: "lpx_test_proxy_token",
          host: "local",
        },
      ],
    }),
    "utf8"
  );
  return file;
}

describe("AI-1767: /proxy/upload endpoint", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-upload-test-"));
    process.env.AGENTS_FILE = writeBrokerAgents(dir);
    resetConfigHealth();
    reloadAgents();
    app = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await request(app.app).get("/proxy/upload?url=https://uploads.linear.app/abc/def");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Missing Authorization/i);
  });

  it("returns 401 when proxy token is not recognized", async () => {
    const res = await request(app.app)
      .get("/proxy/upload?url=https://uploads.linear.app/abc/def")
      .set("Authorization", "lpx_unknown_token");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Unrecognized proxy token/i);
  });

  it("returns 400 when url parameter is missing", async () => {
    const res = await request(app.app)
      .get("/proxy/upload")
      .set("Authorization", "lpx_test_proxy_token");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing.*url/i);
  });

  it("returns 400 when URL is a non-Linear host (token-leak prevention)", async () => {
    globalThis.fetch = jest.fn() as unknown as typeof fetch;

    const res = await request(app.app)
      .get("/proxy/upload?url=https://evil.com/exfil")
      .set("Authorization", "lpx_test_proxy_token");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-Linear host/i);
    // Critical: fetch was never called, so the real token was not leaked
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects non-https URLs", async () => {
    const res = await request(app.app)
      .get("/proxy/upload?url=http://uploads.linear.app/abc/def")
      .set("Authorization", "lpx_test_proxy_token");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-https/i);
  });

  it("fetches the upload with real credentials and streams bytes back", async () => {
    const imageBytes = Buffer.from("fake-image-data-from-linear");

    globalThis.fetch = (jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "image/png",
        "content-length": String(imageBytes.length),
      }),
      arrayBuffer: () =>
        Promise.resolve(
          imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.length)
        ),
    }) as unknown) as typeof fetch;

    const res = await request(app.app)
      .get("/proxy/upload?url=https://uploads.linear.app/abc/def.png")
      .set("Authorization", "lpx_test_proxy_token");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(Buffer.isBuffer(res.body)).toBe(true);

    // Verify the upstream fetch used the REAL token, not the proxy token
    const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(fetchCall[0]).toBe("https://uploads.linear.app/abc/def.png");
    const fetchOpts = fetchCall[1];
    expect(fetchOpts.headers.Authorization).toBe("lin_real_oauth_token");
  });

  it("returns upstream status when Linear returns an error (e.g. 404)", async () => {
    globalThis.fetch = (jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ "content-type": "text/plain" }),
      text: () => Promise.resolve("Not Found"),
    }) as unknown) as typeof fetch;

    const res = await request(app.app)
      .get("/proxy/upload?url=https://uploads.linear.app/abc/missing.png")
      .set("Authorization", "lpx_test_proxy_token");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/HTTP 404/);
  });

  it("returns 502 when the upstream fetch throws a network error", async () => {
    globalThis.fetch = (jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown) as typeof fetch;

    const res = await request(app.app)
      .get("/proxy/upload?url=https://uploads.linear.app/abc/def")
      .set("Authorization", "lpx_test_proxy_token");

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/ECONNREFUSED/);
  });
});
