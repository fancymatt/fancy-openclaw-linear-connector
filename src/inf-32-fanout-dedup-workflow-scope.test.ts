/**
 * INF-32 — Engine: fan-out dedup is unscoped by `child_workflow`.
 *
 * Fan-out spec-entry dedup (AI-1994) is content-hash-only: `deriveFindingId` is
 * FNV-1a over `title\ndescription` and nothing else, `fetchExistingSpawnChildren`
 * reads EVERY marker-bearing child of the parent, and `dedupeSpawnSpec` keys
 * `existingIds` on `specEntryId` alone. So when one parent has two fan-out states
 * sharing a `spec_source`, the second fan-out's findings derive ids that already
 * exist on the first fan-out's children, `toSpawn` empties, and the engine logs
 * "a legitimate no-op, not a refusal" and returns clean. Zero children. Into a
 * `barrier: true` state that vacuously satisfies (AI-1730) and falls through.
 * `unmatchedChildren` cannot catch it either: the colliding id IS in `specIds`,
 * so no orphan note fires. Silent on both sides.
 *
 * These are FAILING tests written BEFORE the implementation (TDD). They pin the
 * observable contract; the implementer (Igor) wires the internals.
 *
 * ── AC of record (captured by Astrid at intake, 2026-07-17) ────────────────
 *
 *   AC1 — Scope dedup by child workflow. `ExistingChild` records the
 *         `child_workflow` that minted it; `dedupeSpawnSpec` treats a child as
 *         already-spawned only when BOTH the spec-entry id AND the
 *         `child_workflow` match. A parent with two fan-outs over the same
 *         `spec_source` mints both children. Back-compat: legacy markers in the
 *         wild carry no `child_workflow` — the read path for them must be
 *         defined, and must NOT silently treat a legacy marker as matching every
 *         workflow (that preserves the bug).
 *   AC2 — Refuse the ambiguous def at validation: two fan-out states sharing a
 *         `spec_source` within one workflow are rejected (or explicitly waived)
 *         at ACTIVATION — not at spawn time.
 *   AC4 — Regression test: one parent, two fan-out states, shared `spec_source`
 *         → the second fan-out mints its child (today: mints nothing, silently).
 *
 *   AC3 (zero-child no-op not silent into a barrier) is DESCOPED from this
 *   ticket at intake — it coordinates with INF-28, whose mechanism was re-decided
 *   (connector-side recorded-child-set store) and whose own work is blocked on
 *   INF-30. It lands with INF-28. No test here asserts it.
 *
 * ── Contract these tests define ────────────────────────────────────────────
 *
 * 1. `ExistingChild` gains an optional `childWorkflow` field: the `wf:*` label of
 *    the workflow that minted the child. Optional because legacy children
 *    predate it (AC1 back-compat).
 *
 * 2. `dedupeSpawnSpec(findings, existingChildren, childWorkflow)` takes the
 *    current fan-out's default `child_workflow` as a third argument. A finding's
 *    EFFECTIVE workflow is `finding.child_workflow ?? childWorkflow` — the
 *    per-entry override (AI-2199) is what the child is actually labeled with at
 *    mint time (`src/fanout.ts:1089`), so it is what dedup must compare.
 *
 * 3. The id-only legacy fallback must be OBSERVABLE, not silent. `dedupeSpawnSpec`
 *    returns a third field `legacyIdOnlyMatches: ExistingChild[]` — children that
 *    suppressed a spawn on an id-only match because their minting workflow could
 *    not be resolved. Suppressing is the conservative choice (never double-mint
 *    against a real legacy parent); reporting it is what makes it non-silent, per
 *    AC1's "do not silently treat legacy markers as matching every workflow".
 *
 * 4. AC1 explicitly allows EITHER read path — "extend the spec-entry marker, or
 *    read the child's `wf:*` label". The integration tests therefore mock a
 *    children query whose nodes carry BOTH a spec-entry marker AND `wf:*` labels,
 *    so either implementation strategy satisfies them. No test asserts a marker
 *    format.
 */

// Namespace import: the INF-32 contract (3-arg `dedupeSpawnSpec`, `childWorkflow`
// on ExistingChild) does not exist yet. A static named import of a missing symbol
// would fail the whole suite at ESM link time (0 tests run); via the namespace the
// symbol resolves to `undefined` until implemented, so these tests fail
// per-assertion — proper TDD red — while the rest of the suite still runs.
import * as fanout from "./fanout.js";
import { validateFanoutBarrierConfig, type WorkflowDef } from "./workflow-gate.js";

const { extractSpecFindings, executeFanout } = fanout;

/** An existing child, optionally carrying the workflow that minted it (AC1). */
interface ScopedExistingChild {
  identifier: string;
  specEntryId: string;
  state?: string;
  /** INF-32: the `wf:*` label of the fan-out that minted this child. */
  childWorkflow?: string;
}

interface ScopedDedupeResult {
  toSpawn: fanout.Finding[];
  unmatchedChildren: ScopedExistingChild[];
  /** INF-32: children that suppressed a spawn via the id-only legacy fallback. */
  legacyIdOnlyMatches?: ScopedExistingChild[];
}

type ScopedDedupe = (
  findings: fanout.Finding[],
  existingChildren: ScopedExistingChild[],
  childWorkflow?: string,
) => ScopedDedupeResult;

const dedupeSpawnSpec = (fanout as unknown as { dedupeSpawnSpec?: ScopedDedupe }).dedupeSpawnSpec
  ?? (() => { throw new Error("dedupeSpawnSpec is not implemented yet (INF-32)"); }) as ScopedDedupe;

const WF_A = "wf:dev-impl";
const WF_B = "wf:sprint-arm-ux";

const FANOUT_A = { spec_source: "findings", child_workflow: WF_A } as const;
const FANOUT_B = { spec_source: "findings", child_workflow: WF_B } as const;

/** Build a `## Findings` spec body from a list of bullet titles. */
function specFrom(titles: string[]): string {
  return ["## Findings", ...titles.map((t) => `- **${t}**: detail for ${t}`)].join("\n");
}

// ── AC1: dedup is scoped by child_workflow (pure core) ─────────────────────

describe("INF-32 AC1 — dedupeSpawnSpec scopes dedup by child_workflow", () => {
  it("a child minted by a DIFFERENT workflow does not suppress the spawn", () => {
    const findings = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    // The first fan-out (WF_A) already minted children for these exact entries.
    // The second fan-out (WF_B) reads the same spec_source → same content → same ids.
    const existingChildren: ScopedExistingChild[] = findings.map((f, i) => ({
      identifier: `AI-300${i + 1}`,
      specEntryId: f.id as string,
      state: "Doing",
      childWorkflow: WF_A,
    }));

    const { toSpawn } = dedupeSpawnSpec(findings, existingChildren, WF_B);

    // Today: toSpawn is [] — the ids collide and the second fan-out mints nothing.
    expect(toSpawn).toHaveLength(2);
    expect(toSpawn.map((f) => f.title).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("a child minted by the SAME workflow still suppresses the spawn (AI-1994 dedup intact)", () => {
    const findings = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const existingChildren: ScopedExistingChild[] = findings.map((f, i) => ({
      identifier: `AI-300${i + 1}`,
      specEntryId: f.id as string,
      state: "Doing",
      childWorkflow: WF_A,
    }));

    const { toSpawn } = dedupeSpawnSpec(findings, existingChildren, WF_A);

    expect(toSpawn).toHaveLength(0);
  });

  it("matches on BOTH id and workflow — same workflow, different id still spawns", () => {
    const before = extractSpecFindings(specFrom(["Alpha"]), "findings");
    const after = extractSpecFindings(specFrom(["Alpha", "Gamma"]), "findings");
    const existingChildren: ScopedExistingChild[] = before.map((f) => ({
      identifier: "AI-3001",
      specEntryId: f.id as string,
      state: "Done",
      childWorkflow: WF_A,
    }));

    const { toSpawn } = dedupeSpawnSpec(after, existingChildren, WF_A);

    expect(toSpawn).toHaveLength(1);
    expect(toSpawn[0].title).toBe("Gamma");
  });

  it("partial overlap: only the entries lacking a same-workflow child are minted", () => {
    const findings = extractSpecFindings(specFrom(["Alpha", "Beta", "Gamma"]), "findings");
    const existingChildren: ScopedExistingChild[] = [
      // Alpha already minted by THIS workflow → suppressed.
      { identifier: "AI-3001", specEntryId: findings[0].id as string, state: "Doing", childWorkflow: WF_B },
      // Beta minted by the OTHER workflow → must NOT suppress this fan-out.
      { identifier: "AI-3002", specEntryId: findings[1].id as string, state: "Doing", childWorkflow: WF_A },
    ];

    const { toSpawn } = dedupeSpawnSpec(findings, existingChildren, WF_B);

    expect(toSpawn.map((f) => f.title).sort()).toEqual(["Beta", "Gamma"]);
  });

  it("compares the finding's EFFECTIVE workflow — per-entry child_workflow override (AI-2199) wins", () => {
    // A per-entry `[wf:… → …]` override is what the child is actually labeled
    // with at mint time (src/fanout.ts:1089), so dedup must compare against the
    // override, not the fan-out config default.
    //
    // Constructed so ONLY the correct implementation passes:
    //   - config default is WF_B, and the existing child is WF_B — so an impl that
    //     compares the CONFIG DEFAULT sees a match and wrongly suppresses;
    //   - the entry overrides to WF_A, and no WF_A child exists — so an impl that
    //     compares the EFFECTIVE workflow correctly mints;
    //   - today's id-only dedup also wrongly suppresses.
    const findings = extractSpecFindings(specFrom(["Alpha"]), "findings");
    const overridden: fanout.Finding[] = [{ ...findings[0], child_workflow: WF_A }];
    const existingChildren: ScopedExistingChild[] = [
      { identifier: "AI-3001", specEntryId: findings[0].id as string, state: "Doing", childWorkflow: WF_B },
    ];

    const { toSpawn } = dedupeSpawnSpec(overridden, existingChildren, WF_B);

    expect(toSpawn).toHaveLength(1);
    expect(toSpawn[0].title).toBe("Alpha");
  });

  it("does not report a different-workflow child as unmatched/orphaned when its entry still exists", () => {
    // The orphan note must be scoped too. A child minted by another fan-out whose
    // spec entry still exists is not an orphan of THIS fan-out — surfacing it
    // would trade the silent no-op for a spurious alarm.
    const findings = extractSpecFindings(specFrom(["Alpha"]), "findings");
    const existingChildren: ScopedExistingChild[] = [
      { identifier: "AI-3001", specEntryId: findings[0].id as string, state: "Doing", childWorkflow: WF_A },
    ];

    const { unmatchedChildren } = dedupeSpawnSpec(findings, existingChildren, WF_B);

    expect(unmatchedChildren).toHaveLength(0);
  });

  it("does not report a different-workflow child as unmatched/orphaned even when its entry is GONE", () => {
    // The sharp edge of orphan-scoping. This child belongs to fan-out A's spec,
    // which this fan-out (B) cannot see and has no authority over. Today
    // `unmatchedChildren` is `existing` minus `specIds` with no workflow scope, so
    // fan-out B reports fan-out A's live child as an orphan — a spurious note
    // pointing a steward at a ticket that is doing exactly what it should.
    const other = extractSpecFindings(specFrom(["Zeta"]), "findings");
    const mine = extractSpecFindings(specFrom(["Alpha"]), "findings");
    const existingChildren: ScopedExistingChild[] = [
      { identifier: "AI-3001", specEntryId: other[0].id as string, state: "Doing", childWorkflow: WF_A },
    ];

    const { unmatchedChildren } = dedupeSpawnSpec(mine, existingChildren, WF_B);

    expect(unmatchedChildren).toHaveLength(0);
  });

  it("still reports a same-workflow child whose spec entry is gone as unmatched (AI-1994 AC2 intact)", () => {
    const before = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const after = extractSpecFindings(specFrom(["Alpha"]), "findings");
    const existingChildren: ScopedExistingChild[] = before.map((f, i) => ({
      identifier: `AI-300${i + 1}`,
      specEntryId: f.id as string,
      state: "Doing",
      childWorkflow: WF_A,
    }));

    const { unmatchedChildren } = dedupeSpawnSpec(after, existingChildren, WF_A);

    expect(unmatchedChildren).toHaveLength(1);
    expect(unmatchedChildren[0].identifier).toBe("AI-3002");
  });
});

// ── AC1 back-compat: legacy markers carry no child_workflow ────────────────

describe("INF-32 AC1 — legacy (workflow-less) children are not silently workflow-agnostic", () => {
  it("a legacy child suppresses only via the id-only fallback, and reports that it did", () => {
    // Conservative: an unresolvable-workflow child still suppresses (never
    // double-mint against a real legacy parent) — but the fallback is REPORTED,
    // which is what AC1's "do not silently treat legacy markers as matching every
    // workflow" requires. Silence is the defect; suppression is not.
    const findings = extractSpecFindings(specFrom(["Alpha"]), "findings");
    const existingChildren: ScopedExistingChild[] = [
      { identifier: "AI-3001", specEntryId: findings[0].id as string, state: "Doing" }, // no childWorkflow
    ];

    const result = dedupeSpawnSpec(findings, existingChildren, WF_B);

    expect(result.legacyIdOnlyMatches).toBeDefined();
    expect(result.legacyIdOnlyMatches).toHaveLength(1);
    expect(result.legacyIdOnlyMatches?.[0].identifier).toBe("AI-3001");
  });

  it("a resolvable-workflow child never lands in the legacy fallback bucket", () => {
    const findings = extractSpecFindings(specFrom(["Alpha"]), "findings");
    const existingChildren: ScopedExistingChild[] = [
      { identifier: "AI-3001", specEntryId: findings[0].id as string, state: "Doing", childWorkflow: WF_A },
    ];

    const result = dedupeSpawnSpec(findings, existingChildren, WF_B);

    expect(result.legacyIdOnlyMatches ?? []).toHaveLength(0);
    expect(result.toSpawn).toHaveLength(1); // different workflow → still mints
  });
});

// ── AC2: def validation refuses two fan-out states sharing a spec_source ────

describe("INF-32 AC2 — def validation rejects two fanout states sharing a spec_source", () => {
  /** Minimal def shell; only the fan-out-bearing states matter here. */
  function defWith(states: Array<Record<string, unknown>>): WorkflowDef {
    return {
      id: "test-wf",
      version: 1,
      states,
    } as unknown as WorkflowDef;
  }

  // ⚠️ AC2 SCOPE NARROWED BY THE IMPLEMENTER (Igor, 2026-07-17) — flagged for
  // Astrid/tdd to accept or overrule; see the handoff comment on INF-32.
  //
  // As originally written, this describe block asserted that ANY two fanout
  // states sharing a `spec_source` are rejected, regardless of child_workflow.
  // That contradicts AC1 and regresses shipped behavior:
  //
  //  - AC1 requires that "a parent with two fanouts over the same spec_source
  //    mints both children". Rejecting the def at activation makes that scenario
  //    unreachable — no def could express what the engine now supports.
  //  - AI-1992 AC4 ships exactly that def (`synthetic-two-phase`: `arming` →
  //    wf:sprint-arm and `impl` → wf:dev-impl, both reading `findings`). The
  //    spec_source-only rule excluded it from the registry and turned 5 green
  //    AI-1992 tests red — verified against a clean baseline.
  //  - The ticket's own rationale is that the engine fix exists "so the next def
  //    doesn't have to know that rule"; a hard activation error re-imposes the
  //    rule the fix was meant to retire.
  //
  // Once dedup is keyed on (specEntryId, child_workflow), a shared spec_source
  // across DIFFERENT child workflows is well-defined. What stays ambiguous is a
  // shared (spec_source, child_workflow) PAIR — the scoped key cannot separate
  // those, and the later fanout still silently mints nothing. That is the case
  // these tests now pin. The two tests below were re-pointed accordingly; the
  // rest of this block is tdd's, unchanged.
  it("rejects two fanout states sharing a spec_source AND child_workflow", () => {
    const def = defWith([
      { id: "spawn-impl", fanout: { spec_source: "findings", child_workflow: WF_A } },
      { id: "launching", fanout: { spec_source: "findings", child_workflow: WF_A } },
    ]);

    const errors = validateFanoutBarrierConfig(def);

    expect(errors.length).toBeGreaterThan(0);
    // The diagnostic must name the shared spec_source and both offending states —
    // a def author reading it should not have to go spelunking.
    const joined = errors.join(" ");
    expect(joined).toContain("findings");
    expect(joined).toContain("spawn-impl");
    expect(joined).toContain("launching");
    // It must also name the shared child_workflow, since that is now half the key.
    expect(joined).toContain(WF_A);
    // ...and must actually RENDER. A `toContain` check alone passes happily on a
    // diagnostic carrying an unsubstituted 'undefined' or a raw key separator —
    // which is exactly what an earlier draft of this validator emitted.
    expect(joined).not.toContain("undefined");
    expect(joined).not.toContain("\u0000");
  });

  it("accepts two fanout states sharing a spec_source into DIFFERENT child workflows (AI-1992 two-phase)", () => {
    // The shape AC1/AC4 exist to make work, and the one AI-1992's
    // `synthetic-two-phase` def ships. Must NOT be refused at activation.
    const def = defWith([
      { id: "arming", fanout: { spec_source: "findings", child_workflow: WF_A } },
      { id: "impl", fanout: { spec_source: "findings", child_workflow: WF_B } },
    ]);

    expect(validateFanoutBarrierConfig(def)).toEqual([]);
  });

  it("accepts two fanout states with DISTINCT spec_sources", () => {
    const def = defWith([
      { id: "spawn-impl", fanout: { spec_source: "findings", child_workflow: WF_A } },
      { id: "launching", fanout: { spec_source: "sprint", child_workflow: WF_B } },
    ]);

    expect(validateFanoutBarrierConfig(def)).toEqual([]);
  });

  it("accepts a single fanout state (no false positive on the common case)", () => {
    const def = defWith([
      { id: "spawn-impl", fanout: { spec_source: "findings", child_workflow: WF_A } },
      { id: "review", barrier: true },
    ]);

    expect(validateFanoutBarrierConfig(def)).toEqual([]);
  });

  it("compares spec_source case-insensitively — extractSpecFindings matches the header that way", () => {
    // `extractSpecFindings` keys the section header case-insensitively
    // (src/fanout.ts:283), so "Findings" and "findings" read the SAME section and
    // collide exactly as the bug describes. The validator must see them as shared.
    // (Re-pointed per the scope note above: child_workflow held equal so the
    // case-insensitivity of spec_source is what this test actually isolates.)
    const def = defWith([
      { id: "spawn-impl", fanout: { spec_source: "findings", child_workflow: WF_A } },
      { id: "launching", fanout: { spec_source: "Findings", child_workflow: WF_A } },
    ]);

    expect(validateFanoutBarrierConfig(def).length).toBeGreaterThan(0);
  });

  it("rejects even when both states fan out into the SAME child_workflow", () => {
    // Same spec_source AND same child_workflow is ambiguous regardless: the
    // scoped dedup key cannot separate them, so the def is still refused.
    const def = defWith([
      { id: "spawn-impl", fanout: { spec_source: "findings", child_workflow: WF_A } },
      { id: "respawn", fanout: { spec_source: "findings", child_workflow: WF_A } },
    ]);

    expect(validateFanoutBarrierConfig(def).length).toBeGreaterThan(0);
  });
});

// ── AC4: regression — two fanouts, one parent, shared spec_source ───────────

describe("INF-32 AC4 — regression: second fanout on one parent mints its child", () => {
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
   * Fan-out fetch mock. `existing` describes the children already hanging off the
   * parent, as the real read path would see them.
   *
   * AC1 permits either read path, so each child node carries BOTH a spec-entry
   * marker in its description AND `wf:*` labels — an implementation that extends
   * the marker and one that reads the child's label both resolve the same
   * workflow from this mock. Nodes also return `labels` unconditionally, so the
   * implementer is free to add `labels { nodes { name } }` to the children query
   * (the current query at src/fanout.ts:1200 does not request it).
   */
  function makeFetch(existing: Array<{ identifier: string; specEntryId: string; childWorkflow: string }>): typeof globalThis.fetch {
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
      if (query.includes("FanoutChildren") || query.includes("children")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                children: {
                  nodes: existing.map((c) => ({
                    identifier: c.identifier,
                    description: [
                      "Parent: AI-1439",
                      `<!-- ai-1994:spec-entry-id: ${c.specEntryId} -->`,
                      `<!-- inf-32:child-workflow: ${c.childWorkflow} -->`,
                    ].join("\n"),
                    state: { name: "Doing" },
                    labels: { nodes: [{ name: c.childWorkflow }, { name: "state:intake" }] },
                  })),
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (query.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                labels: {
                  nodes: [
                    { id: "lbl-wf-dev-impl", name: WF_A },
                    { id: "lbl-wf-sprint-arm-ux", name: WF_B },
                  ],
                },
              },
            },
          }),
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

  it("mints both children when a second fanout re-reads the same spec_source (THE BUG)", async () => {
    // One parent. Fan-out A (wf:dev-impl) has already minted children for every
    // entry of `## Findings`. Fan-out B (wf:sprint-arm-ux) now runs on the same
    // parent, reading the same spec_source → identical content → identical ids.
    const findings = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const existing = findings.map((f, i) => ({
      identifier: `AI-300${i + 1}`,
      specEntryId: f.id as string,
      childWorkflow: WF_A,
    }));

    globalThis.fetch = makeFetch(existing);
    const result = await executeFanout("AI-1439", "Bearer tok", FANOUT_B, {
      skipPreview: true,
    } as never);

    // Today: created === 0. The engine logs "AC3: unchanged spec re-entry … a
    // legitimate no-op, not a refusal" and returns clean — zero children, no
    // refusal, no note.
    expect(result.created).toBe(2);
    const createCalls = fetchCalls.filter((c) => String(c.body.query ?? "").includes("issueCreate"));
    expect(createCalls).toHaveLength(2);
  });

  it("labels the second fanout's children with ITS workflow, not the first's", async () => {
    const findings = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const existing = findings.map((f, i) => ({
      identifier: `AI-300${i + 1}`,
      specEntryId: f.id as string,
      childWorkflow: WF_A,
    }));

    globalThis.fetch = makeFetch(existing);
    await executeFanout("AI-1439", "Bearer tok", FANOUT_B, { skipPreview: true } as never);

    // INF-27 AC2 mint guard: wf:* labels are pre-resolved via TeamLabels lookup
    // and cached. issueLabelCreate is NOT called for them — the cached label ID
    // is passed directly in issueCreate's labelIds. Only non-wf labels like
    // state:intake are still created via issueLabelCreate.
    const labelCalls = fetchCalls.filter((c) => String(c.body.query ?? "").includes("issueLabelCreate"));
    const labelNames = labelCalls.map((c) => (c.body.variables as Record<string, unknown>).name);
    // state:intake is still created via findOrCreateLabel (not a wf:* label).
    expect(labelNames).toContain("state:intake");
    // wf:* labels are NOT created inline — they're pre-resolved by the mint guard.
    expect(labelNames).not.toContain(WF_B);
    expect(labelNames).not.toContain(WF_A);
    // Children were created with pre-resolved label IDs in labelIds.
    const createCalls = fetchCalls.filter((c) => String(c.body.query ?? "").includes("issueCreate"));
    expect(createCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("re-entering the SAME fanout twice still mints nothing (no duplicate-spawn regression)", async () => {
    // The scoping fix must not become a licence to double-mint: fan-out A
    // re-entering its own state, with its own children present, is still a no-op.
    const findings = extractSpecFindings(specFrom(["Alpha", "Beta"]), "findings");
    const existing = findings.map((f, i) => ({
      identifier: `AI-300${i + 1}`,
      specEntryId: f.id as string,
      childWorkflow: WF_A,
    }));

    globalThis.fetch = makeFetch(existing);
    const result = await executeFanout("AI-1439", "Bearer tok", FANOUT_A, {
      skipPreview: true,
    } as never);

    expect(result.created).toBe(0);
    const createCalls = fetchCalls.filter((c) => String(c.body.query ?? "").includes("issueCreate"));
    expect(createCalls).toHaveLength(0);
  });

  it("a fresh parent with no children mints every entry (both fanouts from empty)", async () => {
    globalThis.fetch = makeFetch([]);
    const result = await executeFanout("AI-1439", "Bearer tok", FANOUT_B, {
      skipPreview: true,
    } as never);

    expect(result.created).toBe(2);
  });
});
