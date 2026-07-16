/**
 * AGI-3 — idempotent `issueCreate` dedup guard.
 *
 * The regression under test is the GEN-145/146/147 triple-fire: three creates
 * carrying a byte-identical payload (SHA-256 `34feb898…`) landed in a 9-second
 * window and three agents built the same feature.
 *
 * The proxy tests drive `handleProxyRequest` directly and stub `fetch`, following
 * `idempotency-race.test.ts` — createApp()/SQLite are avoided so these run on
 * arm64 boxes where the better-sqlite3 binding may not be rebuilt.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import request from "supertest";

import { handleProxyRequest, resetIssueCreateDedupCache } from "./proxy.js";
import {
  IssueCreateDedupCache,
  extractIssueCreateInput,
  fingerprintIssueCreate,
  isSuccessfulIssueCreate,
} from "./issue-create-dedup.js";

const CREATE_MUTATION = `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { id identifier title } }
  }
`;

const GEN_145_PAYLOAD = {
  teamId: "team-gen",
  title: "Add server-side resonance-event logging to Vault of Tales",
  description: "# Add server-side resonance-event logging\n\nCycle 2 of the sprint-spawner loop.",
};

function createBody(input: Record<string, unknown>) {
  return { query: CREATE_MUTATION, variables: { input } };
}

function okCreateResponse(identifier: string): string {
  return JSON.stringify({
    data: { issueCreate: { success: true, issue: { id: `uuid-${identifier}`, identifier, title: GEN_145_PAYLOAD.title } } },
  });
}

describe("AGI-3 extractIssueCreateInput", () => {
  it("extracts the input from an issueCreate mutation", () => {
    expect(extractIssueCreateInput(createBody(GEN_145_PAYLOAD))).toEqual(GEN_145_PAYLOAD);
  });

  it("ignores reads and non-create mutations", () => {
    expect(extractIssueCreateInput({ query: "query { issue(id: \"GEN-145\") { id } }" })).toBeNull();
    expect(extractIssueCreateInput({ query: "mutation { issueUpdate(input: {}) { success } }" })).toBeNull();
    expect(extractIssueCreateInput(null)).toBeNull();
    expect(extractIssueCreateInput({ query: 42 })).toBeNull();
  });

  it("matches on the mutation field, not on a caller-supplied operationName", () => {
    const body = { query: CREATE_MUTATION.replace("CreateIssue", "Whatever"), variables: { input: GEN_145_PAYLOAD } };
    expect(extractIssueCreateInput(body)).toEqual(GEN_145_PAYLOAD);
  });
});

describe("AGI-3 fingerprintIssueCreate", () => {
  it("is stable across calls and identical for the GEN-145/146/147 payload", () => {
    const a = fingerprintIssueCreate("astrid", GEN_145_PAYLOAD);
    const b = fingerprintIssueCreate("astrid", { ...GEN_145_PAYLOAD });
    expect(a).toBe(b);
  });

  it("differs by agent, title, description and team", () => {
    const base = fingerprintIssueCreate("astrid", GEN_145_PAYLOAD);
    expect(fingerprintIssueCreate("igor", GEN_145_PAYLOAD)).not.toBe(base);
    expect(fingerprintIssueCreate("astrid", { ...GEN_145_PAYLOAD, title: "other" })).not.toBe(base);
    expect(fingerprintIssueCreate("astrid", { ...GEN_145_PAYLOAD, description: "other" })).not.toBe(base);
    expect(fingerprintIssueCreate("astrid", { ...GEN_145_PAYLOAD, teamId: "team-ai" })).not.toBe(base);
  });

  it("cannot be collided by shifting content across field boundaries", () => {
    // Without length-prefixing, ("ab","c") and ("a","bc") would concatenate alike.
    const x = fingerprintIssueCreate("a", { teamId: "t", title: "ab", description: "c" });
    const y = fingerprintIssueCreate("a", { teamId: "t", title: "a", description: "bc" });
    expect(x).not.toBe(y);
  });
});

describe("AGI-3 isSuccessfulIssueCreate", () => {
  it("accepts only a genuine success", () => {
    expect(isSuccessfulIssueCreate(okCreateResponse("GEN-145"))).toBe(true);
  });

  it("rejects GraphQL errors returned under HTTP 200", () => {
    expect(isSuccessfulIssueCreate(JSON.stringify({ errors: [{ message: "nope" }] }))).toBe(false);
  });

  it("rejects success:false and malformed bodies", () => {
    expect(isSuccessfulIssueCreate(JSON.stringify({ data: { issueCreate: { success: false } } }))).toBe(false);
    expect(isSuccessfulIssueCreate(JSON.stringify({ data: { issueCreate: { success: true } } }))).toBe(false);
    expect(isSuccessfulIssueCreate("not json")).toBe(false);
  });
});

describe("AGI-3 IssueCreateDedupCache", () => {
  it("replays the first response for an identical create inside the TTL", () => {
    const cache = new IssueCreateDedupCache(60_000, () => 1_000);
    const first = cache.claim("h");
    expect(first.kind).toBe("forward");
    if (first.kind !== "forward") throw new Error("unreachable");
    first.settle(okCreateResponse("GEN-145"));

    const second = cache.claim("h");
    expect(second.kind).toBe("replay");
    if (second.kind !== "replay") throw new Error("unreachable");
    expect(second.responseText).toBe(okCreateResponse("GEN-145"));
  });

  it("forwards again once the TTL has elapsed", () => {
    let now = 1_000;
    const cache = new IssueCreateDedupCache(60_000, () => now);
    const first = cache.claim("h");
    if (first.kind !== "forward") throw new Error("unreachable");
    first.settle(okCreateResponse("GEN-145"));

    now += 60_001;
    expect(cache.claim("h").kind).toBe("forward");
  });

  it("does not remember an abandoned (failed) create", () => {
    const cache = new IssueCreateDedupCache(60_000, () => 1_000);
    const first = cache.claim("h");
    if (first.kind !== "forward") throw new Error("unreachable");
    first.abandon();
    expect(cache.claim("h").kind).toBe("forward");
  });

  it("coalesces a concurrent identical create onto the in-flight result", async () => {
    const cache = new IssueCreateDedupCache(60_000, () => 1_000);
    const first = cache.claim("h");
    if (first.kind !== "forward") throw new Error("unreachable");

    const second = cache.claim("h");
    expect(second.kind).toBe("await");
    if (second.kind !== "await") throw new Error("unreachable");

    first.settle(okCreateResponse("GEN-145"));
    await expect(second.wait).resolves.toBe(okCreateResponse("GEN-145"));
  });

  it("releases waiters with null when the in-flight create fails", async () => {
    const cache = new IssueCreateDedupCache(60_000, () => 1_000);
    const first = cache.claim("h");
    if (first.kind !== "forward") throw new Error("unreachable");
    const second = cache.claim("h");
    if (second.kind !== "await") throw new Error("unreachable");

    first.abandon();
    await expect(second.wait).resolves.toBeNull();
  });

  it("keeps distinct payloads independent", () => {
    const cache = new IssueCreateDedupCache(60_000, () => 1_000);
    const a = cache.claim("a");
    if (a.kind !== "forward") throw new Error("unreachable");
    a.settle(okCreateResponse("GEN-145"));
    expect(cache.claim("b").kind).toBe("forward");
  });
});

// ── End-to-end: the GEN-145/146/147 triple-fire through the proxy ───────────

describe("AGI-3 proxy — agent-driven duplicate issueCreate", () => {
  let originalFetch: typeof globalThis.fetch;
  let upstreamCalls: number;
  let minted: string[];

  function createProxyApp(): express.Application {
    const app = express();
    app.use(
      express.raw({ type: "application/json", limit: "1mb" }),
      (req: express.Request, _res: express.Response, next: express.NextFunction) => {
        if (Buffer.isBuffer(req.body)) {
          try { req.body = JSON.parse(req.body.toString("utf8")); } catch { /* leave as-is */ }
        }
        next();
      },
    );
    app.post("/proxy/graphql", async (req, res) => {
      await handleProxyRequest(req, res);
    });
    return app;
  }

  function post(app: express.Application, input: Record<string, unknown>, agent = "astrid") {
    return request(app)
      .post("/proxy/graphql")
      .set("Content-Type", "application/json")
      .set("X-Openclaw-Agent", agent)
      .set("Authorization", "Bearer tok")
      .send(JSON.stringify(createBody(input)));
  }

  beforeEach(() => {
    resetIssueCreateDedupCache();
    originalFetch = globalThis.fetch;
    upstreamCalls = 0;
    minted = [];
    // Each upstream create mints a NEW identifier — exactly as Linear did on
    // 2026-07-12, when three identical payloads became GEN-145/146/147.
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      const identifier = `GEN-${144 + upstreamCalls}`;
      minted.push(identifier);
      return new Response(okCreateResponse(identifier), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.ISSUE_CREATE_DEDUP_TTL_MS;
  });

  it("regression: three identical creates in a burst mint exactly one issue", async () => {
    const app = createProxyApp();

    const r1 = await post(app, GEN_145_PAYLOAD);
    const r2 = await post(app, GEN_145_PAYLOAD);
    const r3 = await post(app, GEN_145_PAYLOAD);

    // The defect: three forwards, three tickets. The guard: one forward.
    expect(upstreamCalls).toBe(1);
    expect(minted).toEqual(["GEN-145"]);

    // All three callers observe success, and all three receive the SAME issue.
    // Replay rather than rejection is the point: an agent that retried because it
    // believed the first attempt failed must not be handed another failure.
    for (const r of [r1, r2, r3]) {
      expect(r.status).toBe(200);
      expect(r.body.data.issueCreate.success).toBe(true);
      expect(r.body.data.issueCreate.issue.identifier).toBe("GEN-145");
    }
  });

  it("coalesces concurrent identical creates onto a single forward", async () => {
    const app = createProxyApp();
    const [r1, r2, r3] = await Promise.all([
      post(app, GEN_145_PAYLOAD),
      post(app, GEN_145_PAYLOAD),
      post(app, GEN_145_PAYLOAD),
    ]);

    expect(upstreamCalls).toBe(1);
    for (const r of [r1, r2, r3]) {
      expect(r.body.data.issueCreate.issue.identifier).toBe("GEN-145");
    }
  });

  it("does not dedup genuinely distinct creates", async () => {
    const app = createProxyApp();
    await post(app, GEN_145_PAYLOAD);
    await post(app, { ...GEN_145_PAYLOAD, title: "A different ticket" });
    expect(upstreamCalls).toBe(2);
  });

  it("scopes the window to the calling agent", async () => {
    const app = createProxyApp();
    await post(app, GEN_145_PAYLOAD, "astrid");
    await post(app, GEN_145_PAYLOAD, "igor");
    expect(upstreamCalls).toBe(2);
  });

  it("does not intercept reads", async () => {
    const app = createProxyApp();
    await request(app)
      .post("/proxy/graphql")
      .set("Content-Type", "application/json")
      .set("X-Openclaw-Agent", "astrid")
      .set("Authorization", "Bearer tok")
      .send(JSON.stringify({ query: `query { issue(id: "GEN-145") { id } }` }));
    await request(app)
      .post("/proxy/graphql")
      .set("Content-Type", "application/json")
      .set("X-Openclaw-Agent", "astrid")
      .set("Authorization", "Bearer tok")
      .send(JSON.stringify({ query: `query { issue(id: "GEN-145") { id } }` }));
    expect(upstreamCalls).toBe(2);
  });

  it("lets a legitimate retry through after the first create fails upstream", async () => {
    const app = createProxyApp();
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      upstreamCalls = call;
      if (call === 1) {
        // Linear reports a rejected mutation as HTTP 200 with a GraphQL errors array.
        return new Response(JSON.stringify({ errors: [{ message: "Argument Validation Error" }] }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(okCreateResponse("GEN-145"), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const r1 = await post(app, GEN_145_PAYLOAD);
    expect(r1.body.errors).toBeDefined();

    // A failure must not be cached — the retry has to reach Linear.
    const r2 = await post(app, GEN_145_PAYLOAD);
    expect(upstreamCalls).toBe(2);
    expect(r2.body.data.issueCreate.issue.identifier).toBe("GEN-145");
  });
});
