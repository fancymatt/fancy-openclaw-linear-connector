import crypto from "crypto";
import request from "supertest";
import { createApp } from "../index";

const SECRET = "test-endpoint-secret";

function sign(body: string): string {
  return crypto
    .createHmac("sha256", SECRET)
    .update(Buffer.from(body))
    .digest("hex");
}

const validIssueBody = JSON.stringify({
  type: "Issue",
  action: "create",
  createdAt: "2026-04-10T12:00:00.000Z",
  actor: { id: "a1", name: "Alice" },
  data: {
    id: "i1",
    identifier: "ENG-1",
    title: "Test issue",
    state: { id: "s1", name: "Todo", type: "unstarted" },
    priority: 0,
    priorityLabel: "No priority",
    team: { id: "t1", key: "ENG" },
    labelIds: [],
    url: "https://.app/test/issue/ENG-1",
    createdAt: "2026-04-10T12:00:00.000Z",
    updatedAt: "2026-04-10T12:00:00.000Z",
  },
});

describe("POST /", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    app = createApp();
  });

  afterEach(() => {
    delete process.env.LINEAR_WEBHOOK_SECRET;
  });

  it("returns 200 for a valid signed request", async () => {
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(validIssueBody))
      .send(validIssueBody);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 401 for an invalid signature", async () => {
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", "deadbeef".repeat(8))
      .send(validIssueBody);

    expect(res.status).toBe(401);
  });

  it("returns 400 when signature header is missing", async () => {
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .send(validIssueBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });

  it("returns 400 for malformed JSON", async () => {
    const badBody = "not-json{{{";
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(badBody))
      .send(badBody);

    expect(res.status).toBe(400);
  });

  it("returns 400 for a payload missing required fields", async () => {
    const badPayload = JSON.stringify({ foo: "bar" });
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(badPayload))
      .send(badPayload);

    expect(res.status).toBe(400);
  });

  it("skips signature validation when LINEAR_WEBHOOK_SECRET is not set", async () => {
    delete process.env.LINEAR_WEBHOOK_SECRET;
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(validIssueBody))
      .send(validIssueBody);

    // When no secret is configured, signature validation is skipped
    expect(res.status).toBe(200);
  });
});
