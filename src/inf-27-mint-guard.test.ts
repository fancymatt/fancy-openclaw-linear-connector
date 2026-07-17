/**
 * INF-27 — AC2: guard the mint.
 *
 * Verbatim AC2:
 *   When a state's description/fanout declares a `child_workflow`, minting that
 *   child into a team where the corresponding `wf:*` label does not exist must
 *   fail loudly rather than produce an inert ticket.
 *
 * Real-world bug (LIF-2): the Sprint 2 child was minted into the LIFE team,
 * which defines no `wf:*` labels. `ensureLabel` silently CREATED `wf:sprint-arm`
 * and minted an inert child under it — no workflow engine ever picked it up. The
 * barrier saw zero live children, satisfied vacuously, and the spawner fell
 * through to `releasing` for a sprint that never started.
 *
 * Current behavior that makes these RED: `fanout.ts`'s private `ensureLabel`
 * (~line 687) is create-on-miss — an absent `wf:*` label is silently created
 * rather than refused. And when label resolution does fail, `executeFanout`'s
 * per-finding `continue` (~line 1096) partial-spawns the remaining findings
 * instead of refusing the whole fan-out.
 *
 * These tests assert ONLY observable fetch/GraphQL behavior and the FanoutResult
 * contract — never which internal function does the work — so the implementer is
 * free to fix `ensureLabel` in place or delete it in favor of `findOrCreateLabel`.
 *
 * NOTE: zero-child barrier behavior (the vacuous-satisfaction half of the LIF-2
 * bug) is DESCOPED from this ticket → INF-28. Nothing here touches `barrier.ts`.
 */

import { executeFanout, type Finding } from "./fanout.js";
import type { FanoutConfig } from "./workflow-gate.js";

// Mirrors the canonical dev-impl child config used throughout fanout.test.ts.
const DEV_IMPL_FANOUT_CONFIG = { spec_source: "findings", child_workflow: "wf:dev-impl" } as FanoutConfig;

const THREE_FINDINGS: Finding[] = [
  { title: "Auth bypass on /api/users" },
  { title: "SQL injection in search" },
  { title: "XSS in profile name" },
];

describe("INF-27 AC2: mint guard — an absent wf:* label must fail loudly, not mint an inert ticket", () => {
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
   * Mock fetch for the fan-out API calls. Mirrors `makeFanoutFetch` in
   * fanout.test.ts (~line 268) — the repo idiom: branch on the GraphQL query
   * string, record every call, return real Response objects.
   */
  function makeFanoutFetch(opts: {
    /** Labels the target team actually defines. Default: none (the LIFE-team case). */
    teamLabels?: Array<{ id: string; name: string }>;
    /** Parent issue context. */
    parentContext?: { teamId: string; title: string; description: string | null; parentIssueId: string | null };
    parentInternalId?: string;
  }): typeof globalThis.fetch {
    const parentInternalId = opts.parentInternalId ?? "parent-internal-uuid";
    let createdCount = 0;

    return (async (url: unknown, init?: RequestInit) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      fetchCalls.push({ url, body: parsed });

      const query = parsed.query ?? "";

      if (query.includes("IssueTeamParent")) {
        const ctx = opts.parentContext ?? {
          teamId: "team-uuid",
          title: "Sprint Spawner Parent",
          description: null,
          parentIssueId: null,
        };
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: parentInternalId,
                title: ctx.title,
                description: ctx.description,
                team: { id: ctx.teamId },
                parent: ctx.parentIssueId ? { id: ctx.parentIssueId } : null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (query.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({ data: { team: { labels: { nodes: opts.teamLabels ?? [] } } } }),
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

      throw new Error(`unexpected query: ${query.slice(0, 100)}`);
    }) as typeof globalThis.fetch;
  }

  const issueCreateCalls = () => fetchCalls.filter((c) => ((c.body.query as string) ?? "").includes("issueCreate"));
  const labelCreateCallsFor = (name: string) =>
    fetchCalls.filter(
      (c) =>
        ((c.body.query as string) ?? "").includes("issueLabelCreate") &&
        ((c.body.variables as Record<string, unknown>)?.name as string) === name,
    );

  // ── AC2 core: absent wf:* label ⇒ loud refusal, zero inert tickets ────────

  it("AC2: refuses the fan-out when the target team does not define the wf:* label — and mints NOTHING", async () => {
    // The LIF-2 shape: team defines state:intake but NO wf:dev-impl.
    globalThis.fetch = makeFanoutFetch({ teamLabels: [{ id: "existing-state-label", name: "state:intake" }] });

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, {
      skipPreview: true,
      findingsOverride: [{ title: "Sprint 2" }],
    });

    // The heart of the AC: no inert ticket may reach Linear.
    expect(issueCreateCalls()).toHaveLength(0);
    // The guard must REFUSE, never silently auto-create a wf:* label.
    expect(labelCreateCallsFor("wf:dev-impl")).toHaveLength(0);

    expect(result.refused).toBe(true);
    expect(result.created).toBe(0);
    expect(result.childIdentifiers).toHaveLength(0);

    // "Fail loudly" = the operator can see WHICH label is missing in WHICH team.
    expect(result.errors.length).toBeGreaterThan(0);
    const messages = result.errors.map((e) => e.message).join(" | ");
    expect(messages).toMatch(/wf:dev-impl/);
    expect(messages).toMatch(/team-uuid/);
  });

  it("AC2: the refusal is ALL-OR-NOTHING across findings — not a per-finding skip", async () => {
    // Today's per-finding `continue` (fanout.ts:1096) would partial-spawn the
    // rest of the findings. A partial spawn is exactly the LIF-2 failure mode:
    // some children exist, the barrier's view is wrong, the parent falls through.
    globalThis.fetch = makeFanoutFetch({ teamLabels: [{ id: "existing-state-label", name: "state:intake" }] });

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, {
      skipPreview: true,
      findingsOverride: THREE_FINDINGS,
    });

    expect(result.created).toBe(0);
    expect(result.childIdentifiers).toHaveLength(0);
    expect(issueCreateCalls()).toHaveLength(0);
    expect(result.refused).toBe(true);
  });

  it("AC2: a per-entry child_workflow override is guarded too (AI-2199 marker path)", async () => {
    // fanout.ts:1089 — `finding.child_workflow ?? childWorkflowLabel`. The
    // per-entry override must be guarded on the same terms as the config-level
    // one; otherwise a `[wf:sprint-scoping → x]` marker reopens the same hole.
    // Config-level wf:dev-impl IS defined; the per-entry wf:sprint-scoping is NOT.
    globalThis.fetch = makeFanoutFetch({
      teamLabels: [
        { id: "existing-wf-label", name: "wf:dev-impl" },
        { id: "existing-state-label", name: "state:intake" },
      ],
    });

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, {
      skipPreview: true,
      findingsOverride: [
        { title: "Ordinary finding" },
        { title: "Scoping arm", child_workflow: "wf:sprint-scoping" },
      ],
    });

    expect(result.refused).toBe(true);
    expect(result.created).toBe(0);
    expect(issueCreateCalls()).toHaveLength(0);
    expect(labelCreateCallsFor("wf:sprint-scoping")).toHaveLength(0);
    const messages = result.errors.map((e) => e.message).join(" | ");
    expect(messages).toMatch(/wf:sprint-scoping/);
  });

  // ── Blast-radius pins: these are EXPECTED TO PASS today ───────────────────

  it("GREEN-PATH GUARD (passes today by design): a team that defines the wf:* label still mints normally", async () => {
    // NOT a red test. This is the regression guard: the AC2 refusal must not
    // break the ordinary fan-out. It passes now and must keep passing after.
    globalThis.fetch = makeFanoutFetch({
      teamLabels: [
        { id: "existing-wf-label", name: "wf:dev-impl" },
        { id: "existing-state-label", name: "state:intake" },
      ],
    });

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, {
      skipPreview: true,
      findingsOverride: THREE_FINDINGS,
    });

    expect(result.created).toBe(3);
    expect(result.refused).toBe(false);
    expect(result.errors).toHaveLength(0);

    const createCalls = issueCreateCalls();
    expect(createCalls).toHaveLength(3);
    for (const call of createCalls) {
      const input = (call.body.variables as Record<string, unknown>).input as Record<string, unknown>;
      expect(input.labelIds).toContain("existing-wf-label");
      expect(input.labelIds).toContain("existing-state-label");
      expect(input.parentId).toBe("parent-internal-uuid");
    }
  });

  it("BLAST-RADIUS PIN (passes today by design): state:intake is still create-on-miss — the guard is scoped to wf:* only", async () => {
    // NOT a red test. AC2 names the `wf:*` label specifically. `state:*` labels
    // are engine-owned bookkeeping and are legitimately created on demand; the
    // guard must not over-refuse and start rejecting teams that simply have not
    // been stamped with state:intake yet.
    globalThis.fetch = makeFanoutFetch({ teamLabels: [{ id: "existing-wf-label", name: "wf:dev-impl" }] });

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, {
      skipPreview: true,
      findingsOverride: [{ title: "Only finding" }],
    });

    expect(labelCreateCallsFor("state:intake")).toHaveLength(1);
    expect(result.refused).toBe(false);
    expect(result.created).toBe(1);
  });

  // ── Pagination: a correctness requirement CREATED by the guard ────────────

  it("AC2: the team-label lookup must paginate — a real wf:* label beyond Linear's default page must be FOUND, not refused", async () => {
    // In scope BECAUSE of the guard. Today an unpaginated lookup that misses a
    // real label merely auto-creates a harmless duplicate. Once the guard lands,
    // a missed real label becomes a HARD REFUSAL that blocks a legitimate mint —
    // so pagination becomes a correctness requirement of AC2 itself.
    //
    // fanout.ts:696 issues `labels { nodes { id name } }` with NO `first:` arg,
    // so Linear returns its default page of 50. The sibling `findOrCreateLabel`
    // in src/linear-helpers.ts:45 already does `labels(first: 250)` plus
    // label-group awareness and the AI-2176 inherited-label fallback; fanout's
    // private `ensureLabel` is a duplicate that drifted. The implementer may well
    // prefer to delete `ensureLabel` and call `findOrCreateLabel` instead — these
    // assertions are deliberately about observable GraphQL only, so either fix passes.
    const labels = Array.from({ length: 60 }, (_, i) => ({ id: `lbl-${i}`, name: `topic-${i}` }));
    labels[3] = { id: "existing-state-label", name: "state:intake" };
    labels[55] = { id: "existing-wf-label", name: "wf:dev-impl" };

    globalThis.fetch = makeFanoutFetch({ teamLabels: labels });

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, {
      skipPreview: true,
      findingsOverride: [{ title: "Sprint 2" }],
    });

    // The lookup must request a page wide enough to see the label, mirroring
    // findOrCreateLabel's `first: 250`.
    const teamLabelQueries = fetchCalls
      .map((c) => (c.body.query as string) ?? "")
      .filter((q) => q.includes("TeamLabels"));
    expect(teamLabelQueries.length).toBeGreaterThan(0);
    for (const q of teamLabelQueries) {
      const match = q.match(/first:\s*(\d+)/);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThanOrEqual(250);
    }

    // And the legitimate mint must go through — the label exists, it is simply late.
    expect(result.refused).toBe(false);
    expect(result.created).toBeGreaterThan(0);
  });
});
