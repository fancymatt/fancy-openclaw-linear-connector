/**
 * AI-1994 — Engine: incremental re-spawn dedup for workflow rework loops.
 *
 * The dev-sprint rework loop (validation → ac-definition → spawn-impl) re-enters
 * a fan-out state. Without dedup, re-entry would duplicate already-spawned
 * children. Fan-out must spawn INCREMENTALLY: only entries with no existing
 * child are minted; existing children (any state) are left untouched; and
 * removing an entry from the spec never cancels its child — the engine posts a
 * note listing unmatched children instead.
 *
 * These are FAILING tests written before the implementation (TDD, AI-1994).
 * They pin the observable contract; the implementer (Igor) wires the internals.
 *
 * ── Contract these tests define ────────────────────────────────────────────
 *
 * 1. Stable IDs are ENGINE-DERIVED from each spec entry (AI-1992 owns the spec
 *    format — title/description bullets, no authored ID field — and this ticket's
 *    scope boundary excludes changing it). `extractSpecFindings` therefore
 *    attaches a deterministic `id` to every Finding. The tests assert only the
 *    PROPERTIES the ACs require (determinism, stability under append,
 *    distinctness) — never a specific slug string — so the implementer is free
 *    to choose the derivation.
 *
 * 2. `dedupeSpawnSpec(findings, existingChildren)` is the pure dedup core:
 *    match is `finding.id === child.specEntryId`. Returns `{ toSpawn,
 *    unmatchedChildren }`. Tests build `existingChildren` from the *actual* ids
 *    that `extractSpecFindings` produces, so they are agnostic to the slug algo.
 *
 * 3. `executeFanout(..., { existingChildren })` integrates dedup: it mints only
 *    `toSpawn`, never mutates/cancels an existing child, and posts a note
 *    comment listing any unmatched children. `existingChildren` is an authoritative
 *    test seam mirroring the established `findingsOverride` / `skipPreview` seams.
 *
 * AC of record (captured by astrid 2026-07-09):
 *   AC1 — Spawn spec entries carry stable IDs. Re-entering a fan-out state spawns
 *         only entries with no existing child ticket; existing children (any
 *         state) are untouched.
 *   AC2 — Removing an entry from the spec does NOT cancel its existing child; the
 *         engine posts a note listing unmatched children instead.
 *   AC3 — Tests: rework loop where the spec gains one entry spawns exactly one new
 *         child; unchanged spec re-entry spawns zero; unmatched-child note emitted.
 */

// Namespace import: `dedupeSpawnSpec` does not exist yet. A static named import
// would fail the whole suite at ESM link time (0 tests run); via the namespace,
// the symbol is simply `undefined` until implemented, so the tests that use it
// fail per-assertion (proper TDD red) while the rest of the suite still runs.
import * as fanout from "./fanout.js";

const { extractSpecFindings, executeFanout } = fanout;
const dedupeSpawnSpec = (fanout as { dedupeSpawnSpec?: (...args: unknown[]) => unknown }).dedupeSpawnSpec
  ?? (() => { throw new Error("dedupeSpawnSpec is not implemented yet (AI-1994)"); });

const DEV_IMPL_FANOUT_CONFIG = {
  spec_source: "findings",
  child_workflow: "wf:dev-impl",
} as const;

/** Build a `## Findings` spec body from a list of bullet titles. */
function specFrom(titles: string[]): string {
  return ["## Findings", ...titles.map((t) => `- **${t}**: detail for ${t}`)].join("\n");
}

// ── AC1: spec entries carry stable, engine-derived IDs ─────────────────────

describe("AI-1994 AC1 — extractSpecFindings attaches stable IDs", () => {
  it("attaches a non-empty id to every extracted entry", () => {
    const findings = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(typeof f.id).toBe("string");
      expect((f.id ?? "").length).toBeGreaterThan(0);
    }
  });

  it("is DETERMINISTIC — identical spec text yields identical ids", () => {
    const spec = specFrom(["Missing auth on /api/users", "SQL injection in search"]);
    const a = extractSpecFindings(spec, "findings").map((f) => f.id);
    const b = extractSpecFindings(spec, "findings").map((f) => f.id);
    // Guard against a vacuous pass: ids must be real, non-empty strings, not undefined.
    expect(a.every((x) => typeof x === "string" && x.length > 0)).toBe(true);
    expect(a).toEqual(b);
  });

  it("gives DISTINCT entries distinct ids", () => {
    const findings = extractSpecFindings(specFrom(["Alpha", "Beta", "Gamma"]), "findings");
    const ids = findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("keeps existing entries' ids STABLE when a new entry is appended", () => {
    // The rework loop appends an entry; the ids of unchanged entries must not shift,
    // or dedup would re-spawn everything.
    const before = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const after = extractSpecFindings(specFrom(["Alpha", "Beta", "Gamma"]), "findings");
    // Guard against a vacuous pass: the shared ids must be real, non-empty strings.
    expect(typeof before[0].id).toBe("string");
    expect((before[0].id ?? "").length).toBeGreaterThan(0);
    expect(after[0].id).toBe(before[0].id);
    expect(after[1].id).toBe(before[1].id);
  });
});

// ── AC1 / AC2: pure dedup core ─────────────────────────────────────────────

describe("AI-1994 — dedupeSpawnSpec (pure core)", () => {
  it("AC1: spawns only entries with no existing child; matched entries suppressed", () => {
    const findings = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const existingChildren = [
      { identifier: "AI-3001", specEntryId: findings[0].id as string, state: "Doing" },
    ];

    const { toSpawn, unmatchedChildren } = dedupeSpawnSpec(findings, existingChildren);

    expect(toSpawn.map((f) => f.id)).toEqual([findings[1].id]); // only Beta
    expect(unmatchedChildren).toHaveLength(0);
  });

  it("AC1: existing children in ANY state (incl. terminal) suppress re-spawn", () => {
    const findings = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const existingChildren = [
      { identifier: "AI-3001", specEntryId: findings[0].id as string, state: "Done" },
      { identifier: "AI-3002", specEntryId: findings[1].id as string, state: "Canceled" },
    ];

    const { toSpawn } = dedupeSpawnSpec(findings, existingChildren);

    expect(toSpawn).toHaveLength(0); // both already have children, terminal or not
  });

  it("AC3: unchanged spec re-entry yields zero to spawn", () => {
    const findings = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const existingChildren = findings.map((f, i) => ({
      identifier: `AI-300${i + 1}`,
      specEntryId: f.id as string,
      state: "Doing",
    }));

    const { toSpawn, unmatchedChildren } = dedupeSpawnSpec(findings, existingChildren);

    expect(toSpawn).toHaveLength(0);
    expect(unmatchedChildren).toHaveLength(0);
  });

  it("AC3: spec that gains one entry yields exactly one to spawn", () => {
    const before = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const existingChildren = before.map((f, i) => ({
      identifier: `AI-300${i + 1}`,
      specEntryId: f.id as string,
      state: "Doing",
    }));
    const after = extractSpecFindings(specFrom(["Alpha", "Beta", "Gamma"]), "findings");

    const { toSpawn, unmatchedChildren } = dedupeSpawnSpec(after, existingChildren);

    expect(toSpawn).toHaveLength(1);
    expect(toSpawn[0].id).toBe(after[2].id); // the new Gamma entry
    expect(unmatchedChildren).toHaveLength(0);
  });

  it("AC2: a removed entry surfaces its child as unmatched (never dropped/cancelled)", () => {
    const before = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const existingChildren = before.map((f, i) => ({
      identifier: `AI-300${i + 1}`,
      specEntryId: f.id as string,
      state: "Doing",
    }));
    // Rework removes "Beta" from the spec.
    const after = extractSpecFindings(specFrom(["Alpha"]), "findings");

    const { toSpawn, unmatchedChildren } = dedupeSpawnSpec(after, existingChildren);

    expect(toSpawn).toHaveLength(0); // Alpha already has a child
    expect(unmatchedChildren.map((c) => c.identifier)).toEqual(["AI-3002"]); // Beta's child
  });
});

// ── AC1 / AC2 / AC3: executeFanout integration ─────────────────────────────

describe("AI-1994 — executeFanout incremental dedup (mocked Linear API)", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Minimal fan-out fetch mock: parent context, labels, child creation, comment.
   * Child ids are minted AI-2001, AI-2002, … in creation order.
   */
  function makeFetch(): typeof globalThis.fetch {
    let createdCount = 0;
    return async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      fetchCalls.push({ url, body: parsed });
      const query = parsed.query ?? "";

      if (query.includes("IssueTeamParent")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "parent-internal-uuid",
                title: "Sprint Parent",
                description: specFrom(["Alpha", "Beta"]),
                team: { id: "team-uuid" },
                parent: null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (query.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({ data: { team: { labels: { nodes: [] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (query.includes("issueLabelCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return new Response(
          JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (query.includes("issueCreate")) {
        createdCount++;
        return new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: { id: `child-uuid-${createdCount}`, identifier: `AI-${2000 + createdCount}` },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (query.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-uuid" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };
  }

  it("AC3: unchanged spec re-entry spawns ZERO new children", async () => {
    const findings = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const existingChildren = findings.map((f, i) => ({
      identifier: `AI-300${i + 1}`,
      specEntryId: f.id as string,
      state: "Doing",
    }));

    globalThis.fetch = makeFetch();
    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, {
      skipPreview: true,
      findingsOverride: findings,
      existingChildren,
    } as never);

    expect(result.created).toBe(0);
    const createCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("issueCreate"));
    expect(createCalls).toHaveLength(0);
  });

  it("AC1/AC3: rework loop that gains one entry spawns EXACTLY ONE new child", async () => {
    const before = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const existingChildren = before.map((f, i) => ({
      identifier: `AI-300${i + 1}`,
      specEntryId: f.id as string,
      state: "Doing",
    }));
    const after = extractSpecFindings(specFrom(["Alpha", "Beta", "Gamma"]), "findings");

    globalThis.fetch = makeFetch();
    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, {
      skipPreview: true,
      findingsOverride: after,
      existingChildren,
    } as never);

    expect(result.created).toBe(1);
    const createCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("issueCreate"));
    expect(createCalls).toHaveLength(1);
    // The single created child is the new "Gamma" entry.
    const input = (createCalls[0].body.variables as Record<string, unknown>).input as Record<string, unknown>;
    expect(String(input.title)).toContain("Gamma");
  });

  it("AC1: existing children (any state) are never mutated on re-entry", async () => {
    const findings = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const existingChildren = [
      { identifier: "AI-3001", specEntryId: findings[0].id as string, state: "Done" },
      { identifier: "AI-3002", specEntryId: findings[1].id as string, state: "Doing" },
    ];

    globalThis.fetch = makeFetch();
    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, {
      skipPreview: true,
      findingsOverride: findings,
      existingChildren,
    } as never);

    // Both entries already have children (Done + Doing): re-entry spawns nothing.
    // (Also fails against no-dedup impl, so this is not a vacuous invariant.)
    expect(result.created).toBe(0);

    // …and no update/cancel/delete/archive mutation may touch an existing child.
    const mutating = fetchCalls.filter((c) =>
      /issueUpdate|issueArchive|issueDelete|archiveIssue/i.test(String(c.body.query ?? "")),
    );
    expect(mutating).toHaveLength(0);
  });

  it("AC2/AC3: a removed entry is NOT cancelled — an unmatched-child note is posted", async () => {
    // Spec now has only "Alpha"; a child exists for the removed "Beta".
    const before = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const after = extractSpecFindings(specFrom(["Alpha"]), "findings");
    const existingChildren = [
      { identifier: "AI-3001", specEntryId: before[0].id as string, state: "Doing" },
      { identifier: "AI-3002", specEntryId: before[1].id as string, state: "Doing" }, // Beta — now unmatched
    ];

    globalThis.fetch = makeFetch();
    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, {
      skipPreview: true,
      findingsOverride: after,
      existingChildren,
    } as never);

    // Nothing spawned (Alpha already has a child), nothing cancelled.
    expect(result.created).toBe(0);
    expect((result as { unmatchedChildren?: string[] }).unmatchedChildren).toEqual(["AI-3002"]);

    const mutating = fetchCalls.filter((c) =>
      /issueUpdate|issueArchive|issueDelete|archiveIssue/i.test(String(c.body.query ?? "")),
    );
    expect(mutating).toHaveLength(0);

    // A note comment listing the unmatched child was posted.
    const noteCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("commentCreate"));
    expect(noteCalls.length).toBeGreaterThanOrEqual(1);
    const noteBodies = noteCalls.map((c) => String((c.body.variables as Record<string, unknown>).body ?? ""));
    expect(noteBodies.some((b) => b.includes("AI-3002"))).toBe(true);
  });
});
