/**
 * AI-2176 — Tests for group-aware label resolution + raw-error surfacing in
 * findOrCreateLabel.
 *
 * Background: LIF-team governed transitions silently declined because
 * create-on-miss for `state:product-definition` fail-closed with no visibility.
 * Grover's forensics (AI-2198) pinned it to B2 label resolution: a team that
 * models `state:*` as a Linear label GROUP ("state") with bare-named children
 * ("product-definition") breaks a blind flat lookup/create.
 *
 * These tests exercise findOrCreateLabel directly:
 *   1. Flat exact match (GEN + flat LIF labels) — unchanged behavior.
 *   2. Group-child match — resolves an existing child of a `state` group.
 *   3. Group-aware create — creates the label under the group (parentId), not flat.
 *   4. Flat create — a team with no group still gets a flat colon-named label.
 *   5. Raw-error surfacing — a non-success create logs the GraphQL errors body.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { findOrCreateLabel } from "./linear-helpers.js";

interface LabelFixture {
  id: string;
  name: string;
  isGroup?: boolean;
  parent?: { id: string; name: string } | null;
  team?: { id: string };
}

interface FetchLog {
  createInputs: Array<Record<string, unknown>>;
}

/**
 * Build a fetch mock that returns `labels` on the TeamLabels lookup and a
 * configurable outcome on issueLabelCreate. Records every create input so tests
 * can assert whether a flat or group-child create was issued.
 */
function makeFetch(
  labels: LabelFixture[],
  createOutcome: { success: boolean; id?: string; errors?: unknown },
  log: FetchLog,
): typeof globalThis.fetch {
  return (async (_url: string, init?: RequestInit) => {
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Buffer
          ? init.body.toString()
          : "";
    if (bodyText.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: labels } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (bodyText.includes("issueLabelCreate")) {
      const parsed = JSON.parse(bodyText) as { variables: Record<string, unknown> };
      log.createInputs.push(parsed.variables);
      const body: Record<string, unknown> = {
        data: {
          issueLabelCreate: {
            success: createOutcome.success,
            issueLabel: createOutcome.success ? { id: createOutcome.id } : null,
          },
        },
      };
      if (createOutcome.errors) body.errors = createOutcome.errors;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

describe("findOrCreateLabel — group-aware resolution (AI-2176)", () => {
  let originalFetch: typeof globalThis.fetch;
  let log: FetchLog;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    log = { createInputs: [] };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("returns the id of an existing flat label without creating (GEN path)", async () => {
    globalThis.fetch = makeFetch(
      [{ id: "flat-uuid", name: "state:product-definition", team: { id: "team-gen" } }],
      { success: false },
      log,
    );
    const id = await findOrCreateLabel("team-gen", "state:product-definition", "Bearer t");
    expect(id).toBe("flat-uuid");
    expect(log.createInputs).toHaveLength(0); // no create attempted
  });

  it("resolves an existing group child without creating (LIF nested path)", async () => {
    globalThis.fetch = makeFetch(
      [
        { id: "grp-uuid", name: "state", isGroup: true, team: { id: "team-lif" } },
        {
          id: "child-uuid",
          name: "product-definition",
          isGroup: false,
          parent: { id: "grp-uuid", name: "state" },
          team: { id: "team-lif" },
        },
      ],
      { success: false },
      log,
    );
    const id = await findOrCreateLabel("team-lif", "state:product-definition", "Bearer t");
    expect(id).toBe("child-uuid");
    expect(log.createInputs).toHaveLength(0);
  });

  it("creates the label under the group when the group exists but the child is missing", async () => {
    globalThis.fetch = makeFetch(
      [{ id: "grp-uuid", name: "state", isGroup: true, team: { id: "team-lif" } }],
      { success: true, id: "new-child-uuid" },
      log,
    );
    const id = await findOrCreateLabel("team-lif", "state:product-definition", "Bearer t");
    expect(id).toBe("new-child-uuid");
    expect(log.createInputs).toHaveLength(1);
    // Created as a child: bare name + parentId pointing at the group.
    expect(log.createInputs[0]).toMatchObject({
      name: "product-definition",
      parentId: "grp-uuid",
    });
  });

  it("creates a flat colon-named label when no group exists (unchanged behavior)", async () => {
    globalThis.fetch = makeFetch([], { success: true, id: "flat-new-uuid" }, log);
    const id = await findOrCreateLabel("team-gen", "state:product-definition", "Bearer t");
    expect(id).toBe("flat-new-uuid");
    expect(log.createInputs).toHaveLength(1);
    expect(log.createInputs[0]).toMatchObject({ name: "state:product-definition" });
    expect(log.createInputs[0]).not.toHaveProperty("parentId");
  });

  it("rejects inherited parent-team label and falls through to create (AI-2557)", async () => {
    // A label named "state:product-definition" exists but is owned by team-gen
    // (the parent team). findOrCreateLabel("team-lif", ...) must NOT return
    // the inherited label ID — it must fall through to create → replaceTeamLabels.
    globalThis.fetch = makeFetch(
      [
        {
          id: "gen-label-uuid",
          name: "state:product-definition",
          team: { id: "team-gen" },
        },
      ],
      { success: true, id: "lif-label-uuid" },
      log,
    );
    const id = await findOrCreateLabel("team-lif", "state:product-definition", "Bearer t");
    // Must NOT return gen-label-uuid — that's the inherited label from parent team.
    expect(id).toBe("lif-label-uuid");
    expect(id).not.toBe("gen-label-uuid");
    expect(log.createInputs).toHaveLength(1); // create attempted
  });

  it("fail-closes to null AND logs the raw GraphQL errors body on create failure (AI-2177)", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = makeFetch(
      [],
      { success: false, errors: [{ message: "A label with this name already exists." }] },
      log,
    );
    const id = await findOrCreateLabel("team-lif", "state:product-definition", "Bearer t");
    expect(id).toBeNull();
    // The raw GraphQL error must reach the logs — this is the opacity fix.
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("A label with this name already exists.");
    expect(logged).toContain("state:product-definition");
  });
});

// ── AI-2020: fetchLastCommentByUser tests ────────────────────────────────
// The helper returns the last non-empty comment from the specified user, or
// null if none found. Comments are returned in ascending order from the API;
// the helper scans newest-to-oldest to find the target user's last comment.

import { fetchLastCommentByUser } from "./linear-helpers.js";

describe("fetchLastCommentByUser — AI-2020", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const USER_ID = "target-user-uuid";

  function makeCommentFetch(
    comments: Array<{ body: string; createdAt: string; user: { id: string } | null }>,
  ): typeof globalThis.fetch {
    return async (url: unknown, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("LastCommentByUser")) {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  comments: { nodes: comments },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }
      return originalFetch(url, init);
    };
  }

  it("returns the last (newest) comment from the specified user", async () => {
    globalThis.fetch = makeCommentFetch([
      { body: "First comment from target", createdAt: "2026-07-17T10:00:00Z", user: { id: USER_ID } },
      { body: "Comment from other user", createdAt: "2026-07-17T11:00:00Z", user: { id: "other-uuid" } },
      { body: "Last comment from target", createdAt: "2026-07-17T12:00:00Z", user: { id: USER_ID } },
    ]);
    const result = await fetchLastCommentByUser("AI-2020", USER_ID, "Bearer tok");
    expect(result).not.toBeNull();
    expect(result!.body).toBe("Last comment from target");
    expect(result!.createdAt).toBe("2026-07-17T12:00:00Z");
  });

  it("returns null when the specified user has no comments", async () => {
    globalThis.fetch = makeCommentFetch([
      { body: "Comment from other user", createdAt: "2026-07-17T10:00:00Z", user: { id: "other-uuid" } },
      { body: "Another comment", createdAt: "2026-07-17T11:00:00Z", user: { id: "other-uuid-2" } },
    ]);
    const result = await fetchLastCommentByUser("AI-2020", USER_ID, "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns null when there are no comments at all", async () => {
    globalThis.fetch = makeCommentFetch([]);
    const result = await fetchLastCommentByUser("AI-2020", USER_ID, "Bearer tok");
    expect(result).toBeNull();
  });

  it("skips empty-body comments from the target user", async () => {
    globalThis.fetch = makeCommentFetch([
      { body: "", createdAt: "2026-07-17T10:00:00Z", user: { id: USER_ID } },
      { body: "   ", createdAt: "2026-07-17T11:00:00Z", user: { id: USER_ID } },
      { body: "Real comment", createdAt: "2026-07-17T12:00:00Z", user: { id: USER_ID } },
    ]);
    const result = await fetchLastCommentByUser("AI-2020", USER_ID, "Bearer tok");
    expect(result).not.toBeNull();
    expect(result!.body).toBe("Real comment");
  });

  it("returns null when the user only has empty-body comments", async () => {
    globalThis.fetch = makeCommentFetch([
      { body: "", createdAt: "2026-07-17T10:00:00Z", user: { id: USER_ID } },
      { body: "   ", createdAt: "2026-07-17T11:00:00Z", user: { id: USER_ID } },
    ]);
    const result = await fetchLastCommentByUser("AI-2020", USER_ID, "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns null and does not throw when API call fails", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };
    const result = await fetchLastCommentByUser("AI-2020", USER_ID, "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns null when issue is not found", async () => {
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({ data: { issue: null } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const result = await fetchLastCommentByUser("nonexistent-id", USER_ID, "Bearer tok");
    expect(result).toBeNull();
  });
});
