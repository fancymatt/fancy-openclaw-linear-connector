/**
 * AI-1986 — Webhook registration UI: self-service webhook management API.
 *
 * These are the FAILING tests (TDD write-tests state) that grade the backend
 * `/admin/api/webhooks` CRUD surface. They cover the API-observable contract of
 * every in-scope acceptance criterion. They do NOT dictate the storage
 * implementation — `id` is treated as opaque, and url/teamLabel are asserted via
 * round-trip only, so the implementer is free to choose how the metadata is
 * persisted alongside the secret.
 *
 * ── Contract defined by these tests ──────────────────────────────────────────
 *   Route prefix: /admin/api/webhooks   (mounted under /admin, mirrors /api/*).
 *   Auth: same `x-admin-secret` / ADMIN_SECRET gate as the rest of the admin API.
 *
 *   GET  /admin/api/webhooks
 *     → 200 { webhooks: Row[] }
 *   POST /admin/api/webhooks   body { url, secret, teamLabel? }
 *     → 200 { ok: true, webhook: Row } on success
 *     → 400 { ok: false, error } on validation failure / malformed JSON
 *   DELETE /admin/api/webhooks/:id
 *     → 200 { ok: true } and the secret is removed from runtime + persistence
 *     → 404 when the id is unknown
 *
 *   Row = { id: string, url: string, teamLabel: string,
 *           secretPreview: string, lastSeen: string | null }
 *     - secretPreview is a MASKED form of the secret (e.g. `lin_wh_…Sjo`):
 *       it must never contain the full secret and must expose only a suffix.
 *
 *   Persistence (AC4): the signing secret is appended to / removed from the
 *   `LINEAR_WEBHOOK_SECRETS` entry of an env file. The env file path is taken
 *   from `process.env.WEBHOOK_ENV_FILE` (falling back to the repo-root `.env`
 *   in production), matching the existing env-seam convention
 *   (WORKFLOW_DEFS_DIR / ADMIN_WEB_DIST). The handler must also update
 *   `process.env.LINEAR_WEBHOOK_SECRETS` in-process so `parseWebhookSecrets()`
 *   reflects the change on the very next request (the AC4 "hot reload").
 *
 * Each test maps back to the AC it proves via the describe() title.
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import { parseWebhookSecrets } from "./webhook/signature.js";

const ADMIN_SECRET = "ai1986-webhooks-test";

interface WebhookRow {
  id: string;
  url: string;
  teamLabel: string;
  secretPreview: string;
  lastSeen: string | null;
}

function tmpDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai1986-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

describe("AI-1986 — /admin/api/webhooks self-service management", () => {
  let app: ReturnType<typeof createApp>;
  let mirrorDbPath: string;
  let eventsDbPath: string;
  let envDir: string;
  let envFile: string;

  const VALID_URL = "https://linear-webhook.fancymatt.com/webhook";
  const VALID_SECRET = "lin_wh_abcdef1234567890Sjo";
  const VALID_TEAM = "Private Team A";

  function makeApp(): ReturnType<typeof createApp> {
    return createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
  }

  /** Add a webhook via the API and return the created row (fails the test on error). */
  async function addWebhook(
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app.app)
      .post("/admin/api/webhooks")
      .set("x-admin-secret", ADMIN_SECRET)
      .set("Content-Type", "application/json")
      .send(body);
  }

  async function listWebhooks(): Promise<WebhookRow[]> {
    const res = await request(app.app)
      .get("/admin/api/webhooks")
      .set("x-admin-secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.webhooks)).toBe(true);
    return res.body.webhooks as WebhookRow[];
  }

  beforeEach(() => {
    mirrorDbPath = tmpDbPath("mirror");
    eventsDbPath = tmpDbPath("events");
    envDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1986-env-"));
    envFile = path.join(envDir, ".env");
    fs.writeFileSync(envFile, "");
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.WEBHOOK_ENV_FILE = envFile;
    delete process.env.LINEAR_WEBHOOK_SECRETS;
    delete process.env.LINEAR_WEBHOOK_SECRET;
    app = makeApp();
  });

  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    delete process.env.WEBHOOK_ENV_FILE;
    delete process.env.LINEAR_WEBHOOK_SECRETS;
    delete process.env.LINEAR_WEBHOOK_SECRET;
    fs.rmSync(path.dirname(mirrorDbPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(eventsDbPath), { recursive: true, force: true });
    fs.rmSync(envDir, { recursive: true, force: true });
  });

  // ── AC5 — Auth-gated ──────────────────────────────────────────────────────
  describe("AC5: all webhook routes require admin auth", () => {
    it("GET rejects a request with no x-admin-secret (401)", async () => {
      const res = await request(app.app).get("/admin/api/webhooks");
      expect(res.status).toBe(401);
    });

    it("POST rejects a request with no x-admin-secret (401)", async () => {
      const res = await request(app.app)
        .post("/admin/api/webhooks")
        .set("Content-Type", "application/json")
        .send({ url: VALID_URL, secret: VALID_SECRET });
      expect(res.status).toBe(401);
    });

    it("DELETE rejects a request with no x-admin-secret (401)", async () => {
      const res = await request(app.app).delete("/admin/api/webhooks/anything");
      expect(res.status).toBe(401);
    });

    it("GET rejects a request with a wrong x-admin-secret (401)", async () => {
      const res = await request(app.app)
        .get("/admin/api/webhooks")
        .set("x-admin-secret", "wrong-secret");
      expect(res.status).toBe(401);
    });

    it("returns 503 when ADMIN_SECRET is not configured", async () => {
      delete process.env.ADMIN_SECRET;
      const res = await request(app.app)
        .get("/admin/api/webhooks")
        .set("x-admin-secret", ADMIN_SECRET);
      expect(res.status).toBe(503);
    });

    it("routes an authenticated request to a real webhooks handler (not 404)", async () => {
      // Proves the route actually exists behind the auth gate — the negative
      // auth cases above are satisfied by the shared /api middleware even with
      // no route mounted, so this positive case is what makes AC5 red pre-impl.
      const res = await request(app.app)
        .get("/admin/api/webhooks")
        .set("x-admin-secret", ADMIN_SECRET);
      expect(res.status).toBe(200);
    });
  });

  // ── AC1 — Webhook list page (GET) ─────────────────────────────────────────
  describe("AC1: GET /admin/api/webhooks lists registered webhooks with metadata", () => {
    it("returns an empty webhooks array when none are registered", async () => {
      const res = await request(app.app)
        .get("/admin/api/webhooks")
        .set("x-admin-secret", ADMIN_SECRET);
      expect(res.status).toBe(200);
      expect(res.body.webhooks).toEqual([]);
    });

    it("lists a registered webhook with url, team label, masked secret and last-seen status", async () => {
      await addWebhook({ url: VALID_URL, secret: VALID_SECRET, teamLabel: VALID_TEAM });
      const rows = await listWebhooks();
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row.url).toBe(VALID_URL);
      expect(row.teamLabel).toBe(VALID_TEAM);
      // "status: last-seen timestamp" — the field must exist (null until first delivery).
      expect(row).toHaveProperty("lastSeen");
      // Each webhook must carry a stable id for deletion.
      expect(typeof row.id).toBe("string");
      expect(row.id.length).toBeGreaterThan(0);
    });

    it("never exposes the full signing secret — only a masked preview suffix", async () => {
      await addWebhook({ url: VALID_URL, secret: VALID_SECRET, teamLabel: VALID_TEAM });
      const [row] = await listWebhooks();
      expect(row.secretPreview).not.toContain(VALID_SECRET);
      // Preview surfaces only the trailing characters of the secret.
      expect(row.secretPreview).toContain(VALID_SECRET.slice(-3));
      expect(row.secretPreview.length).toBeLessThan(VALID_SECRET.length);
    });
  });

  // ── AC2 — Add webhook form (POST + validation) ────────────────────────────
  describe("AC2: POST /admin/api/webhooks adds a webhook with validation", () => {
    it("accepts a valid { url, secret, teamLabel } and echoes the created row", async () => {
      const res = await addWebhook({ url: VALID_URL, secret: VALID_SECRET, teamLabel: VALID_TEAM });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.webhook.url).toBe(VALID_URL);
      expect(res.body.webhook.teamLabel).toBe(VALID_TEAM);
    });

    it("makes the new webhook appear in the list immediately", async () => {
      await addWebhook({ url: VALID_URL, secret: VALID_SECRET, teamLabel: VALID_TEAM });
      const rows = await listWebhooks();
      expect(rows.some((r) => r.url === VALID_URL)).toBe(true);
    });

    it("rejects an empty secret (400)", async () => {
      const res = await addWebhook({ url: VALID_URL, secret: "", teamLabel: VALID_TEAM });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it("rejects a missing secret field (400)", async () => {
      const res = await addWebhook({ url: VALID_URL, teamLabel: VALID_TEAM });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it("rejects a non-HTTPS URL (400)", async () => {
      const res = await addWebhook({ url: "http://insecure.example.com/webhook", secret: VALID_SECRET });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it("rejects a malformed URL (400)", async () => {
      const res = await addWebhook({ url: "not-a-valid-url", secret: VALID_SECRET });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it("rejects a missing url field (400)", async () => {
      const res = await addWebhook({ secret: VALID_SECRET, teamLabel: VALID_TEAM });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it("rejects a malformed JSON body (400)", async () => {
      const res = await request(app.app)
        .post("/admin/api/webhooks")
        .set("x-admin-secret", ADMIN_SECRET)
        .set("Content-Type", "application/json")
        .send("{ this is not json ");
      expect(res.status).toBe(400);
    });

    it("teamLabel is optional — a valid add without it still succeeds", async () => {
      const res = await addWebhook({ url: VALID_URL, secret: VALID_SECRET });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ── AC4 — Persistence + hot reload ────────────────────────────────────────
  describe("AC4: secrets persist to the env file and hot-reload per request", () => {
    it("appends the new secret to LINEAR_WEBHOOK_SECRETS in the env file", async () => {
      await addWebhook({ url: VALID_URL, secret: VALID_SECRET, teamLabel: VALID_TEAM });
      const contents = fs.readFileSync(envFile, "utf8");
      const line = contents.split("\n").find((l) => l.startsWith("LINEAR_WEBHOOK_SECRETS="));
      expect(line).toBeDefined();
      expect(line).toContain(VALID_SECRET);
    });

    it("makes the secret visible to parseWebhookSecrets() immediately (hot reload)", async () => {
      expect(parseWebhookSecrets()).not.toContain(VALID_SECRET);
      await addWebhook({ url: VALID_URL, secret: VALID_SECRET, teamLabel: VALID_TEAM });
      expect(parseWebhookSecrets()).toContain(VALID_SECRET);
    });

    it("appends without clobbering an existing secret in the list", async () => {
      const existing = "lin_wh_existing_secret_0001";
      fs.writeFileSync(envFile, `LINEAR_WEBHOOK_SECRETS=${existing}\n`);
      process.env.LINEAR_WEBHOOK_SECRETS = existing;
      app = makeApp();

      await addWebhook({ url: VALID_URL, secret: VALID_SECRET, teamLabel: VALID_TEAM });

      const contents = fs.readFileSync(envFile, "utf8");
      expect(contents).toContain(existing);
      expect(contents).toContain(VALID_SECRET);
      const secrets = parseWebhookSecrets();
      expect(secrets).toContain(existing);
      expect(secrets).toContain(VALID_SECRET);
    });
  });

  // ── AC3 — Remove webhook (DELETE) ─────────────────────────────────────────
  describe("AC3: DELETE /admin/api/webhooks/:id removes the secret and persists", () => {
    it("removes the webhook from the list", async () => {
      await addWebhook({ url: VALID_URL, secret: VALID_SECRET, teamLabel: VALID_TEAM });
      const [row] = await listWebhooks();

      const del = await request(app.app)
        .delete(`/admin/api/webhooks/${encodeURIComponent(row.id)}`)
        .set("x-admin-secret", ADMIN_SECRET);
      expect(del.status).toBe(200);
      expect(del.body.ok).toBe(true);

      const rows = await listWebhooks();
      expect(rows.some((r) => r.id === row.id)).toBe(false);
    });

    it("removes the secret from runtime (parseWebhookSecrets) and the env file", async () => {
      await addWebhook({ url: VALID_URL, secret: VALID_SECRET, teamLabel: VALID_TEAM });
      expect(parseWebhookSecrets()).toContain(VALID_SECRET);
      const [row] = await listWebhooks();

      await request(app.app)
        .delete(`/admin/api/webhooks/${encodeURIComponent(row.id)}`)
        .set("x-admin-secret", ADMIN_SECRET);

      expect(parseWebhookSecrets()).not.toContain(VALID_SECRET);
      const contents = fs.readFileSync(envFile, "utf8");
      const line = contents.split("\n").find((l) => l.startsWith("LINEAR_WEBHOOK_SECRETS="));
      // Either the line is gone/empty or it no longer contains the secret.
      expect(line?.includes(VALID_SECRET) ?? false).toBe(false);
    });

    it("returns 404 when deleting an unknown id", async () => {
      const res = await request(app.app)
        .delete("/admin/api/webhooks/does-not-exist")
        .set("x-admin-secret", ADMIN_SECRET);
      expect(res.status).toBe(404);
    });

    it("removes only the targeted webhook, leaving others intact", async () => {
      await addWebhook({ url: VALID_URL, secret: VALID_SECRET, teamLabel: VALID_TEAM });
      const otherSecret = "lin_wh_second_secret_9999";
      await addWebhook({ url: "https://other.fancymatt.com/hook", secret: otherSecret, teamLabel: "Team B" });

      const rows = await listWebhooks();
      const target = rows.find((r) => r.url === VALID_URL)!;

      await request(app.app)
        .delete(`/admin/api/webhooks/${encodeURIComponent(target.id)}`)
        .set("x-admin-secret", ADMIN_SECRET);

      const remaining = parseWebhookSecrets();
      expect(remaining).not.toContain(VALID_SECRET);
      expect(remaining).toContain(otherSecret);
    });
  });
});
