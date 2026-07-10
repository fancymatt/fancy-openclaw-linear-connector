/**
 * AI-2038 (P4-C3) — Proposal generation engine: deterministic, rule-based.
 *
 * RE-CUT to the AC3.1 `targets[]` core (steward ruling 2026-07-10 06:04Z /
 * re-accept 16:12Z). The superseded v1 singular shape (top-level
 * oldContent/newContent/diff, idempotencyKey === sha256(diff)) is GONE — a
 * proposal now carries a non-empty `targets[]` array so one (workflow, state)
 * fix can touch both its step-guidance file AND its workflow YAML def.
 *
 * AC coverage in this file:
 *   AC3.1 — the generated proposal object carries every named field; `targets`
 *           is a non-empty array sorted ascending by `path` (byte order); each
 *           entry is {kind, path, old_content:{hash,snapshot}, new_content, diff}
 *           with `kind` emitted by the generator (never inferred from the path
 *           or file extension); idempotency_key uses the normative
 *           hash-per-field derivation.
 *   AC3.2 — rule-based templates only; identical input cluster yields a
 *           byte-identical proposal (determinism), with a FIXED known-answer
 *           vector pinned against the exact idempotency derivation. No ML, no
 *           clock, no RNG.
 *   AC3.5 — multi-workflow findings produce separate proposals per workflow,
 *           never one combined proposal; `targets[]` groups files WITHIN one
 *           (workflow_id, state_id), never across.
 *
 * AC3.3/AC3.4 (store + in-place revision) live in proposal-store.test.ts.
 * AC3.6 (cron bootstrap wiring + liveness) lives in
 * ai-2038-generation-cron-bootstrap.test.ts.
 *
 * ── Contract the implementer conforms to ────────────────────────────────────
 * Module: src/proposal/proposal-generator.ts
 *
 *   export type TargetKind = "guidance" | "yaml";
 *
 *   export interface FailureCluster {         // from C2 (AI-2037, AC2.1)
 *     workflow: string;          // → proposal.workflowId
 *     step: string;              // → proposal.stateId   (C2 calls it `step`)
 *     reasonCode: string;
 *     count: number;
 *     fromBody?: string;
 *     exceedsThreshold: boolean;
 *     ticketIds: string[];       // AC2.1 contributing ticket ids
 *   }
 *
 *   // The mutation surfaces the fired rule template selects for a
 *   // (workflowId, stateId) — each with its canonical on-disk path, kind (from
 *   // the template, NOT sniffed from the extension) and current content. This
 *   // is the seam the amended AC needs: one (workflow, state) can expose both a
 *   // guidance file and a YAML def, so the generator emits one target per
 *   // surface. An EMPTY array means no editable surface exists (e.g. the
 *   // guidance file is absent) → the generator skips the cluster and emits no
 *   // proposal (steward ruling, AI-2038 16:12Z).
 *   export interface EditableSurface {
 *     kind: TargetKind;
 *     path: string;
 *     content: string;
 *   }
 *   export interface GenerationContext {
 *     readSurfaces(workflowId: string, stateId: string): EditableSurface[];
 *   }
 *
 *   export interface ProposalTarget {
 *     kind: TargetKind;
 *     path: string;
 *     oldContent: { hash: string; snapshot: string };  // captured at gen time
 *     newContent: string;
 *     diff: string;
 *   }
 *
 *   export interface GeneratedProposal {
 *     workflowId: string;
 *     stateId: string;
 *     targets: ProposalTarget[];   // non-empty, sorted ASC by path (byte order)
 *     confidenceScore: number;     // deterministic rule output in [0,1]
 *     evidenceCluster: { ticketIds: string[]; counts: Record<string, number> };
 *     failureCount: number;
 *     version: number;
 *     idempotencyKey: string;      // = computeIdempotencyKey(targets)
 *   }
 *
 *   export function generateProposals(
 *     clusters: FailureCluster[],
 *     ctx: GenerationContext,
 *   ): GeneratedProposal[];
 *
 *   // Normative idempotency derivation (AC3.1), exported as the single source of
 *   // truth so the generator, the store and the revision path all agree. Sorts
 *   // targets by `path` (byte order) internally, then:
 *   //   sha256hex( concat( sorted.map(t => sha256hex(t.path) + sha256hex(t.diff)) ) )
 *   // all digests lowercase hex, input bytes utf-8.
 *   export function computeIdempotencyKey(
 *     targets: Array<{ path: string; diff: string }>,
 *   ): string;
 *
 * Grouping rule (Igor's published contract §5, confirmed at re-accept):
 * one proposal per (workflowId, stateId). Clusters that share a (workflow, step)
 * but differ by reasonCode merge into ONE proposal whose evidenceCluster.counts
 * is keyed by reasonCode and whose failureCount is the sum. Clusters in
 * different workflows NEVER merge (AC3.5). `targets[]` groups the files touched
 * within that single (workflow, state) — it is not a back door to a combined
 * cross-workflow proposal.
 *
 * The deterministic core carries NO lifecycle fields (id/status/timestamps) —
 * those belong to the stored record. A timestamp in here breaks AC3.2.
 *
 * RED until src/proposal/proposal-generator.ts exists.
 */

import { createHash } from "node:crypto";
import { describe, it, expect, afterEach, jest } from "@jest/globals";

import {
  generateProposals,
  computeIdempotencyKey,
  type FailureCluster,
  type EditableSurface,
  type GenerationContext,
  type GeneratedProposal,
  type ProposalTarget,
} from "./proposal-generator.js";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Byte-order (utf-8) path comparison — what "sorted ascending by path" means. */
const byPathBytes = (a: { path: string }, b: { path: string }): number =>
  Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));

/**
 * Editable surfaces keyed by `${workflow}/${step}`. `dev-impl/code-review`
 * deliberately exposes BOTH a guidance file and the workflow YAML — the
 * both-surfaces case the AC3.1 amendment exists for. The others expose guidance
 * only. `dev-impl/deploy` is intentionally ABSENT (→ readSurfaces returns []).
 *
 * Note the two dev-impl paths: byte order puts `workflows/dev-impl.yaml`
 * ('.' = 0x2E) BEFORE `workflows/dev-impl/code-review.md` ('/' = 0x2F), so a
 * correct sort is not the same as a naive alphabetical-by-basename sort.
 */
const SURFACES: Record<string, EditableSurface[]> = {
  "dev-impl/code-review": [
    {
      kind: "guidance",
      path: "workflows/dev-impl/code-review.md",
      content: "# Step: code-review\n\n## What to do\n\nReview the pushed branch against the AC of record.\n",
    },
    {
      kind: "yaml",
      path: "workflows/dev-impl.yaml",
      content: "states:\n  code-review:\n    legal: [submit]\n",
    },
  ],
  "dev-impl/write-tests": [
    {
      kind: "guidance",
      path: "workflows/dev-impl/write-tests.md",
      content: "# Step: write-tests\n\n## What to do\n\nWrite failing tests covering all in-scope AC.\n",
    },
  ],
  "dev-sprint/ac-definition": [
    {
      kind: "guidance",
      path: "workflows/dev-sprint/ac-definition.md",
      content: "# Step: ac-definition\n\n## What to do\n\nCapture verbatim acceptance criteria.\n",
    },
  ],
};

const ctx: GenerationContext = {
  readSurfaces: (workflowId, stateId) => SURFACES[`${workflowId}/${stateId}`] ?? [],
};

function cluster(over: Partial<FailureCluster> = {}): FailureCluster {
  return {
    workflow: "dev-impl",
    step: "code-review",
    reasonCode: "missing-tests",
    count: 7,
    exceedsThreshold: true,
    ticketIds: ["AI-1001", "AI-1002", "AI-1003"],
    ...over,
  };
}

afterEach(() => {
  jest.useRealTimers();
});

// ── AC3.1 — proposal object shape (targets[] core) ───────────────────────────

describe("AC3.1: generator emits a fully-formed proposal object for a threshold-crossing cluster", () => {
  it("emits exactly one proposal carrying every AC3.1 top-level field", () => {
    const proposals = generateProposals([cluster()], ctx);
    expect(proposals).toHaveLength(1);
    const [p] = proposals;

    expect(p.workflowId).toBe("dev-impl");
    expect(p.stateId).toBe("code-review");
    expect(Array.isArray(p.targets)).toBe(true);
    expect(typeof p.confidenceScore).toBe("number");
    expect(Array.isArray(p.evidenceCluster.ticketIds)).toBe(true);
    expect(typeof p.evidenceCluster.counts).toBe("object");
    expect(typeof p.failureCount).toBe("number");
    expect(typeof p.version).toBe("number");
    expect(typeof p.idempotencyKey).toBe("string");
  });

  it("carries a NON-EMPTY targets array — the singular v1 diff shape is gone", () => {
    const [p] = generateProposals([cluster()], ctx);

    expect(p.targets.length).toBeGreaterThanOrEqual(1);
    // The superseded flat shape must not survive on the object.
    expect(p as unknown as Record<string, unknown>).not.toHaveProperty("diff");
    expect(p as unknown as Record<string, unknown>).not.toHaveProperty("oldContent");
    expect(p as unknown as Record<string, unknown>).not.toHaveProperty("newContent");
  });

  it("groups both mutation surfaces of one (workflow, state) into one proposal's targets[]", () => {
    // dev-impl/code-review exposes guidance + YAML → one proposal, two targets.
    const [p] = generateProposals([cluster()], ctx);

    expect(p.targets).toHaveLength(2);
    expect(p.targets.map((t) => t.kind).sort()).toEqual(["guidance", "yaml"]);
    expect(p.targets.map((t) => t.path).sort()).toEqual(
      ["workflows/dev-impl.yaml", "workflows/dev-impl/code-review.md"].sort(),
    );
  });

  it("shapes every target as {kind, path, old_content:{hash,snapshot}, new_content, diff}", () => {
    const [p] = generateProposals([cluster()], ctx);

    for (const t of p.targets) {
      expect(["guidance", "yaml"]).toContain(t.kind);
      expect(typeof t.path).toBe("string");
      expect(t.path.length).toBeGreaterThan(0);
      expect(typeof t.oldContent.hash).toBe("string");
      expect(typeof t.oldContent.snapshot).toBe("string");
      expect(typeof t.newContent).toBe("string");
      expect(typeof t.diff).toBe("string");
    }
  });

  it("captures each target's old_content as a {hash, snapshot} of that surface at generation time", () => {
    const [p] = generateProposals([cluster()], ctx);
    const surfaces = SURFACES["dev-impl/code-review"];

    for (const t of p.targets) {
      const src = surfaces.find((s) => s.path === t.path)!;
      expect(t.oldContent.snapshot).toBe(src.content);
      expect(t.oldContent.hash).toBe(sha256(src.content));
    }
  });

  it("sorts targets ascending by path in BYTE order (yaml before its own state's guidance)", () => {
    const [p] = generateProposals([cluster()], ctx);

    const sorted = [...p.targets].sort(byPathBytes);
    expect(p.targets).toEqual(sorted);
    // The specific byte-order discriminator: '.' (0x2E) < '/' (0x2F).
    expect(p.targets[0].path).toBe("workflows/dev-impl.yaml");
    expect(p.targets[1].path).toBe("workflows/dev-impl/code-review.md");
  });

  it("emits `kind` from the rule template, NEVER inferred from the path extension", () => {
    // A surface whose kind DISAGREES with its extension: the rule template says
    // "yaml" but the path ends in .md. A generator that sniffs the extension
    // would emit "guidance"; the AC requires it to carry the template's kind.
    const misleading: GenerationContext = {
      readSurfaces: () => [
        { kind: "yaml", path: "workflows/dev-impl/looks-like-guidance.md", content: "states: {}\n" },
      ],
    };
    const [p] = generateProposals([cluster()], misleading);

    expect(p.targets).toHaveLength(1);
    expect(p.targets[0].kind).toBe("yaml");
  });

  it("produces a real edit per target — non-empty diff that changes the content", () => {
    const [p] = generateProposals([cluster()], ctx);

    for (const t of p.targets) {
      expect(t.diff.length).toBeGreaterThan(0);
      expect(t.newContent).not.toBe(t.oldContent.snapshot);
    }
  });

  it("derives idempotency_key via the normative hash-per-field composition over targets", () => {
    const [p] = generateProposals([cluster()], ctx);

    expect(p.idempotencyKey).toBe(computeIdempotencyKey(p.targets));
    expect(p.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("takes evidence (contributing ticket ids + per-reason-code counts) verbatim from the cluster", () => {
    const [p] = generateProposals([cluster({ count: 7, ticketIds: ["AI-1001", "AI-1002"] })], ctx);

    expect(p.evidenceCluster.ticketIds).toEqual(["AI-1001", "AI-1002"]);
    expect(p.evidenceCluster.counts).toEqual({ "missing-tests": 7 });
    expect(p.failureCount).toBe(7);
  });

  it("starts a freshly generated proposal at version 1", () => {
    const [p] = generateProposals([cluster()], ctx);
    expect(p.version).toBe(1);
  });

  it("scores confidence deterministically within [0,1]", () => {
    const [p] = generateProposals([cluster()], ctx);

    expect(p.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(p.confidenceScore).toBeLessThanOrEqual(1);
    expect(Number.isFinite(p.confidenceScore)).toBe(true);
  });

  it("generates only for clusters that exceed the threshold", () => {
    const proposals = generateProposals(
      [
        cluster({ exceedsThreshold: false, step: "write-tests" }),
        cluster({ exceedsThreshold: true, step: "code-review" }),
      ],
      ctx,
    );

    expect(proposals).toHaveLength(1);
    expect(proposals[0].stateId).toBe("code-review");
  });

  it("emits nothing when no cluster exceeds the threshold", () => {
    expect(generateProposals([cluster({ exceedsThreshold: false })], ctx)).toEqual([]);
  });

  it("emits nothing for an empty cluster list", () => {
    expect(generateProposals([], ctx)).toEqual([]);
  });

  // Steward ruling (AI-2038 16:12Z): guidance file absent ⇒ no editable surface
  // ⇒ skip the cluster, emit no proposal. Proposing brand-new-file creation is a
  // distinct rule template, out of scope here.
  it("skips a threshold-crossing cluster whose (workflow, state) has no editable surface", () => {
    const orphan = cluster({ step: "deploy" }); // dev-impl/deploy ∉ SURFACES → []
    expect(generateProposals([orphan], ctx)).toEqual([]);
  });

  it("skips only the surface-less cluster, still emitting for its viable neighbours", () => {
    const proposals = generateProposals(
      [cluster({ step: "deploy" }), cluster({ step: "code-review" })],
      ctx,
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].stateId).toBe("code-review");
  });
});

// ── AC3.2 — determinism, rule-based only, known-answer vector ─────────────────

describe("AC3.2: identical input cluster yields an identical proposal (rule-based, no ML)", () => {
  it("produces deep-equal proposals across two independent generation calls", () => {
    const a = generateProposals([cluster()], ctx);
    const b = generateProposals([cluster()], ctx);

    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces a byte-identical proposal when the wall clock differs between runs", () => {
    // A timestamp leaking into the deterministic core is the most likely way
    // AC3.2 breaks. Generate at two very different system times and demand
    // byte-identical output.
    jest.useFakeTimers();

    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const first = generateProposals([cluster()], ctx);

    jest.setSystemTime(new Date("2027-09-14T13:37:42.000Z"));
    const second = generateProposals([cluster()], ctx);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second[0].idempotencyKey).toBe(first[0].idempotencyKey);
  });

  it("serializes without any ISO-8601 timestamp in the deterministic core", () => {
    const [p] = generateProposals([cluster()], ctx);
    expect(JSON.stringify(p)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("carries no lifecycle fields — those belong to the stored record", () => {
    const [p] = generateProposals([cluster()], ctx) as unknown as Array<Record<string, unknown>>;

    expect(p).not.toHaveProperty("id");
    expect(p).not.toHaveProperty("status");
    expect(p).not.toHaveProperty("createdAt");
    expect(p).not.toHaveProperty("updatedAt");
  });

  it("is insensitive to the order clusters arrive in", () => {
    const c1 = cluster({ workflow: "dev-impl", step: "code-review" });
    const c2 = cluster({ workflow: "dev-sprint", step: "ac-definition" });

    const forward = generateProposals([c1, c2], ctx);
    const reverse = generateProposals([c2, c1], ctx);

    const key = (p: GeneratedProposal) => `${p.workflowId}/${p.stateId}`;
    expect(forward.map(key).sort()).toEqual(reverse.map(key).sort());

    for (const f of forward) {
      const r = reverse.find((x) => key(x) === key(f))!;
      expect(r.idempotencyKey).toBe(f.idempotencyKey);
      expect(r.targets).toEqual(f.targets);
    }
  });

  it("changes the idempotency_key when an underlying surface changes", () => {
    // Same cluster, different surface content → different diff → different key.
    // Proves the key is a content hash, not a hash of the cluster identity.
    const drifted: GenerationContext = {
      readSurfaces: (w, s) =>
        (SURFACES[`${w}/${s}`] ?? []).map((sf) =>
          sf.kind === "guidance" ? { ...sf, content: sf.content + "\nDrifted.\n" } : sf,
        ),
    };

    const [base] = generateProposals([cluster()], ctx);
    const [after] = generateProposals([cluster()], drifted);

    expect(after.idempotencyKey).not.toBe(base.idempotencyKey);
  });

  it("changes the idempotency_key when the failure evidence changes the rendered edit", () => {
    const [low] = generateProposals([cluster({ count: 4, reasonCode: "missing-tests" })], ctx);
    const [high] = generateProposals([cluster({ count: 4, reasonCode: "scope-creep" })], ctx);

    expect(high.idempotencyKey).not.toBe(low.idempotencyKey);
  });

  // ── The normative idempotency derivation, pinned as a fixed known-answer ────
  // vector (AC3.1 says: "This exact derivation is normative; the AC3.2
  // determinism test asserts a fixed known-answer vector against it").
  //
  //   idempotency_key = sha256hex( concat( sorted.map(t =>
  //                        sha256hex(t.path) + sha256hex(t.diff) ) ) )
  //   sorted = targets sorted ascending by path (byte order)
  //   all digests lowercase hex, input bytes utf-8.
  //
  // The expected value below was computed independently from that formula.
  describe("computeIdempotencyKey — normative hash-per-field derivation", () => {
    // Passed UNSORTED on purpose: guidance first, yaml second. The derivation
    // must sort by path (byte order) before hashing → yaml ('.') sorts first.
    const KA_TARGETS: Array<{ kind: ProposalTarget["kind"]; path: string; diff: string }> = [
      { kind: "guidance", path: "workflows/dev-impl/code-review.md", diff: "@@ -1 +1 @@\n-old guidance\n+new guidance\n" },
      { kind: "yaml", path: "workflows/dev-impl.yaml", diff: "@@ -3 +3 @@\n-  legal: [submit]\n+  legal: [submit, request-changes]\n" },
    ];
    const KA_EXPECTED = "486808f3b57e9ae857988074adc96bb10b0cf86d5d107cb6735758ab38ea62ba";

    it("matches the fixed known-answer vector", () => {
      expect(computeIdempotencyKey(KA_TARGETS)).toBe(KA_EXPECTED);
    });

    it("is a lowercase 64-char hex digest", () => {
      expect(computeIdempotencyKey(KA_TARGETS)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("sorts by path (byte order) internally — input order does not change the key", () => {
      const reversed = [...KA_TARGETS].reverse();
      expect(computeIdempotencyKey(reversed)).toBe(KA_EXPECTED);
    });

    it("reproduces the derivation from first principles (path & diff both hashed)", () => {
      const sorted = [...KA_TARGETS].sort(byPathBytes);
      const expected = sha256(sorted.map((t) => sha256(t.path) + sha256(t.diff)).join(""));
      expect(computeIdempotencyKey(KA_TARGETS)).toBe(expected);
    });

    it("is sensitive to a path change (not diff-only)", () => {
      const moved = [{ ...KA_TARGETS[0], path: KA_TARGETS[0].path + ".moved" }, KA_TARGETS[1]];
      expect(computeIdempotencyKey(moved)).not.toBe(KA_EXPECTED);
    });
  });
});

// ── AC3.5 — separate proposals per workflow, never combined ──────────────────

describe("AC3.5: multi-workflow findings produce separate proposals per workflow", () => {
  const multi: FailureCluster[] = [
    cluster({ workflow: "dev-impl", step: "code-review", reasonCode: "missing-tests", count: 9, ticketIds: ["AI-1001", "AI-1002"] }),
    cluster({ workflow: "dev-sprint", step: "ac-definition", reasonCode: "ac-mismatch", count: 5, ticketIds: ["AI-2001"] }),
  ];

  it("emits one proposal per workflow, never a combined one", () => {
    const proposals = generateProposals(multi, ctx);

    expect(proposals).toHaveLength(2);
    expect(proposals.map((p) => p.workflowId).sort()).toEqual(["dev-impl", "dev-sprint"]);
  });

  it("gives each proposal a single workflow_id and state_id — no merged identity", () => {
    for (const p of generateProposals(multi, ctx)) {
      expect(typeof p.workflowId).toBe("string");
      expect(p.workflowId).not.toContain(",");
      expect(p.stateId).not.toContain(",");
    }
  });

  it("never leaks one workflow's evidence into another workflow's proposal", () => {
    const proposals = generateProposals(multi, ctx);

    const devImpl = proposals.find((p) => p.workflowId === "dev-impl")!;
    const devSprint = proposals.find((p) => p.workflowId === "dev-sprint")!;

    expect(devImpl.evidenceCluster.ticketIds).toEqual(["AI-1001", "AI-1002"]);
    expect(devImpl.evidenceCluster.ticketIds).not.toContain("AI-2001");

    expect(devSprint.evidenceCluster.ticketIds).toEqual(["AI-2001"]);
    expect(devSprint.failureCount).toBe(5);
  });

  it("gives each workflow's proposal a distinct idempotency_key", () => {
    const [a, b] = generateProposals(multi, ctx);
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it("keeps every target of a proposal scoped to that one (workflow, state) — targets[] is not a cross-workflow merge", () => {
    // The dev-impl/code-review proposal touches TWO files, but both belong to
    // that single (workflow, state). targets[] groups WITHIN a pair; it is not
    // a mechanism for combining proposals across workflows/states (AC3.5).
    const [devImpl] = generateProposals([multi[0]], ctx);

    expect(devImpl.targets.length).toBe(2);
    for (const t of devImpl.targets) {
      // Both surfaces live under the dev-impl workflow's config tree.
      expect(t.path.startsWith("workflows/dev-impl")).toBe(true);
    }
  });

  it("separates proposals per state within the same workflow", () => {
    const proposals = generateProposals(
      [
        cluster({ workflow: "dev-impl", step: "code-review" }),
        cluster({ workflow: "dev-impl", step: "write-tests" }),
      ],
      ctx,
    );

    expect(proposals).toHaveLength(2);
    expect(proposals.map((p) => p.stateId).sort()).toEqual(["code-review", "write-tests"]);
  });

  it("merges reason codes within one (workflow, state) into a single proposal with summed evidence", () => {
    const proposals = generateProposals(
      [
        cluster({ step: "code-review", reasonCode: "missing-tests", count: 6, ticketIds: ["AI-1001"] }),
        cluster({ step: "code-review", reasonCode: "correctness", count: 4, ticketIds: ["AI-1002"] }),
      ],
      ctx,
    );

    expect(proposals).toHaveLength(1);
    const [p] = proposals;
    expect(p.evidenceCluster.counts).toEqual({ "missing-tests": 6, correctness: 4 });
    expect(p.failureCount).toBe(10);
    expect(p.evidenceCluster.ticketIds.sort()).toEqual(["AI-1001", "AI-1002"]);
  });
});
