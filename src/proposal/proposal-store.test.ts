/**
 * AI-2038 (P4-C3) — Proposal store: status-queryable persistence + in-place revision.
 *
 * RE-CUT to the AC3.1 `targets[]` core (steward ruling 2026-07-10 06:04Z /
 * re-accept 16:12Z). The stored record and every revision entry now carry a
 * `targets[]` array, not the superseded flat oldContent/newContent/diff.
 *
 * AC coverage in this file:
 *   AC3.3 — proposals persist in a store queryable by status:
 *           pending / approved / rejected / applied / apply-failed / in-revision.
 *   AC3.4 — revise: operator feedback attaches to the proposal; regeneration
 *           updates the proposal IN PLACE, preserving revision history
 *           (UX decision #3). Revision entries carry the regenerated `targets`.
 *
 * ── Contract the implementer conforms to ────────────────────────────────────
 * Module: src/proposal/proposal-store.ts   (follows src/store/observation-store.ts:
 * better-sqlite3, WAL, private migrate(), snake_case columns / camelCase TS)
 *
 *   export const PROPOSAL_STATUSES = [
 *     "pending", "approved", "rejected", "applied", "apply-failed", "in-revision",
 *   ] as const;
 *   export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
 *
 *   export interface ProposalRevision {
 *     version: number;            // the superseded version this entry preserves
 *     feedback: string;           // the operator ask that superseded it
 *     targets: ProposalTarget[];  // the superseded version's regenerated targets
 *     idempotencyKey: string;
 *     createdAt: string;
 *   }
 *
 *   export interface ProposalRecord extends GeneratedProposal {  // targets[] core
 *     id: number;
 *     status: ProposalStatus;
 *     createdAt: string;
 *     updatedAt: string;
 *     revisions: ProposalRevision[];
 *   }
 *
 *   export class ProposalStore {
 *     constructor(dbPath?: string);              // defaults to ${DATA_DIR}/proposals.db
 *     create(p: GeneratedProposal): ProposalRecord;          // status = "pending"
 *     get(id: number): ProposalRecord | null;
 *     query(q?: { status?: ProposalStatus; workflowId?: string; limit?: number }): ProposalRecord[];
 *     setStatus(id: number, status: ProposalStatus): ProposalRecord;
 *     revise(id: number, feedback: string, regenerated: GeneratedProposal): ProposalRecord;
 *     close(): void;
 *   }
 *
 * Revision semantics (confirmed at re-accept): `revise()` mutates the SAME row.
 * The superseded version's `targets` are pushed onto `revisions[]` together with
 * the operator feedback that superseded it, so every prior version is
 * recoverable and the ask/response thread survives. The record itself always
 * holds the CURRENT version. History is immutable.
 *
 * Lifecycle fields (id/status/createdAt/updatedAt/revisions) are excluded from
 * the deterministic core — see AC3.2 in proposal-generator.test.ts.
 *
 * RED until src/proposal/proposal-store.ts exists.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import {
  computeIdempotencyKey,
  type GeneratedProposal,
  type ProposalTarget,
} from "./proposal-generator.js";
import {
  ProposalStore,
  PROPOSAL_STATUSES,
  type ProposalStatus,
} from "./proposal-store.js";

let dir: string;
let store: ProposalStore;

/** A both-surfaces targets[] core, mirroring what the generator emits. */
function targets(seed = "old"): ProposalTarget[] {
  const guidanceOld = `# Step: code-review\n\n${seed} guidance\n`;
  const yamlOld = `states:\n  code-review:\n    legal: [submit] # ${seed}\n`;
  return [
    {
      kind: "yaml",
      path: "workflows/dev-impl.yaml",
      oldContent: { hash: sha(yamlOld), snapshot: yamlOld },
      newContent: "states:\n  code-review:\n    legal: [submit, request-changes]\n",
      diff: `@@ yaml ${seed} @@\n-  legal: [submit]\n+  legal: [submit, request-changes]\n`,
    },
    {
      kind: "guidance",
      path: "workflows/dev-impl/code-review.md",
      oldContent: { hash: sha(guidanceOld), snapshot: guidanceOld },
      newContent: `# Step: code-review\n\n${seed} guidance\n\n## Reviewer checklist\n- confirm tests exist\n`,
      diff: `@@ guidance ${seed} @@\n+## Reviewer checklist\n+- confirm tests exist\n`,
    },
  ];
}

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function proposal(over: Partial<GeneratedProposal> = {}): GeneratedProposal {
  const t = over.targets ?? targets();
  return {
    workflowId: "dev-impl",
    stateId: "code-review",
    targets: t,
    confidenceScore: 0.75,
    evidenceCluster: { ticketIds: ["AI-1001", "AI-1002"], counts: { "missing-tests": 7 } },
    failureCount: 7,
    version: 1,
    idempotencyKey: computeIdempotencyKey(t),
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2038-proposal-store-"));
  store = new ProposalStore(path.join(dir, "proposals.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── AC3.3 — persistence + status-queryable store ─────────────────────────────

describe("AC3.3: proposals persist in a store queryable by status", () => {
  it("persists a generated proposal and returns it with an id at status pending", () => {
    const rec = store.create(proposal());

    expect(typeof rec.id).toBe("number");
    expect(rec.status).toBe("pending");
    expect(rec.workflowId).toBe("dev-impl");
    expect(rec.stateId).toBe("code-review");
    expect(rec.revisions).toEqual([]);
  });

  it("round-trips the whole targets[] core through SQLite without loss", () => {
    const input = proposal();
    const rec = store.get(store.create(input).id)!;

    expect(rec.targets).toEqual(input.targets);
    expect(rec.idempotencyKey).toBe(input.idempotencyKey);
    expect(rec.confidenceScore).toBeCloseTo(input.confidenceScore, 10);
    expect(rec.evidenceCluster).toEqual(input.evidenceCluster);
    expect(rec.failureCount).toBe(input.failureCount);
    expect(rec.version).toBe(input.version);
  });

  it("preserves each target's kind, path, old_content and diff on round-trip", () => {
    const input = proposal();
    const rec = store.get(store.create(input).id)!;

    expect(rec.targets).toHaveLength(input.targets.length);
    for (let i = 0; i < input.targets.length; i++) {
      expect(rec.targets[i].kind).toBe(input.targets[i].kind);
      expect(rec.targets[i].path).toBe(input.targets[i].path);
      expect(rec.targets[i].oldContent).toEqual(input.targets[i].oldContent);
      expect(rec.targets[i].newContent).toBe(input.targets[i].newContent);
      expect(rec.targets[i].diff).toBe(input.targets[i].diff);
    }
  });

  it("exposes exactly the six AC3.3 status values", () => {
    expect([...PROPOSAL_STATUSES].sort()).toEqual(
      ["applied", "apply-failed", "approved", "in-revision", "pending", "rejected"].sort(),
    );
  });

  it("queries by each of the six statuses, returning only matching proposals", () => {
    const ids: Record<string, number> = {};
    for (const status of PROPOSAL_STATUSES) {
      // Distinct idempotency key per row so they are independent records.
      const rec = store.create(proposal({ targets: targets(status) }));
      store.setStatus(rec.id, status);
      ids[status] = rec.id;
    }

    for (const status of PROPOSAL_STATUSES) {
      const found = store.query({ status });
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe(ids[status]);
      expect(found[0].status).toBe(status);
    }
  });

  it("returns an empty list for a status with no proposals", () => {
    store.create(proposal());
    expect(store.query({ status: "applied" })).toEqual([]);
  });

  it("returns all proposals when no status filter is given", () => {
    store.create(proposal({ targets: targets("one") }));
    store.create(proposal({ targets: targets("two") }));

    expect(store.query()).toHaveLength(2);
  });

  it("survives a store reopen — proposals are on disk, not in memory", () => {
    const dbPath = path.join(dir, "proposals.db");
    const input = proposal();
    const id = store.create(input).id;
    store.setStatus(id, "approved");
    store.close();

    store = new ProposalStore(dbPath);
    const rec = store.get(id)!;

    expect(rec.status).toBe("approved");
    expect(rec.targets).toEqual(input.targets);
  });

  it("rejects a status outside the AC3.3 enum", () => {
    const id = store.create(proposal()).id;
    expect(() => store.setStatus(id, "yolo" as unknown as ProposalStatus)).toThrow();
  });

  it("returns null for an unknown proposal id", () => {
    expect(store.get(9999)).toBeNull();
  });

  it("filters by workflow id so C5 can scope the review queue", () => {
    store.create(proposal({ workflowId: "dev-impl", targets: targets("a") }));
    store.create(proposal({ workflowId: "dev-sprint", targets: targets("b") }));

    const found = store.query({ workflowId: "dev-sprint" });
    expect(found).toHaveLength(1);
    expect(found[0].workflowId).toBe("dev-sprint");
  });
});

// ── AC3.4 — revise in place, preserving revision history ─────────────────────

describe("AC3.4: revise attaches operator feedback and updates the proposal in place", () => {
  const v2 = () =>
    proposal({
      targets: targets("revised"),
      version: 2,
    });

  it("updates the SAME row — no second proposal is created", () => {
    const id = store.create(proposal()).id;

    const revised = store.revise(id, "Too aggressive — soften the checklist.", v2());

    expect(revised.id).toBe(id);
    expect(store.query()).toHaveLength(1);
  });

  it("advances the record to the regenerated targets and bumps the version", () => {
    const id = store.create(proposal()).id;
    const next = v2();

    const revised = store.revise(id, "Soften it.", next);

    expect(revised.version).toBe(2);
    expect(revised.targets).toEqual(next.targets);
    expect(revised.idempotencyKey).toBe(next.idempotencyKey);
  });

  it("moves the proposal to in-revision status", () => {
    const id = store.create(proposal()).id;
    expect(store.revise(id, "Soften it.", v2()).status).toBe("in-revision");
  });

  it("preserves the superseded version's targets and the operator feedback that superseded it", () => {
    const original = proposal();
    const id = store.create(original).id;

    const revised = store.revise(id, "Too aggressive — soften the checklist.", v2());

    expect(revised.revisions).toHaveLength(1);
    const [r] = revised.revisions;
    expect(r.version).toBe(1);
    expect(r.feedback).toBe("Too aggressive — soften the checklist.");
    expect(r.targets).toEqual(original.targets);
    expect(r.idempotencyKey).toBe(original.idempotencyKey);
    expect(typeof r.createdAt).toBe("string");
  });

  it("accumulates the full ask/response thread across repeated revisions", () => {
    const original = proposal();
    const id = store.create(original).id;

    const second = v2();
    store.revise(id, "first ask", second);
    const third = proposal({ targets: targets("third"), version: 3 });
    const final = store.revise(id, "second ask", third);

    expect(final.version).toBe(3);
    expect(final.targets).toEqual(third.targets);
    expect(final.revisions).toHaveLength(2);

    expect(final.revisions[0].version).toBe(1);
    expect(final.revisions[0].feedback).toBe("first ask");
    expect(final.revisions[0].targets).toEqual(original.targets);

    expect(final.revisions[1].version).toBe(2);
    expect(final.revisions[1].feedback).toBe("second ask");
    expect(final.revisions[1].targets).toEqual(second.targets);
  });

  it("keeps revision history immutable — an earlier entry is never rewritten", () => {
    const id = store.create(proposal()).id;
    const afterFirst = store.revise(id, "first ask", v2());
    const snapshot = JSON.stringify(afterFirst.revisions[0]);

    const afterSecond = store.revise(id, "second ask", proposal({ targets: targets("x3"), version: 3 }));

    expect(JSON.stringify(afterSecond.revisions[0])).toBe(snapshot);
  });

  it("persists revision history across a store reopen", () => {
    const dbPath = path.join(dir, "proposals.db");
    const original = proposal();
    const id = store.create(original).id;
    store.revise(id, "keep this thread", v2());
    store.close();

    store = new ProposalStore(dbPath);
    const rec = store.get(id)!;

    expect(rec.version).toBe(2);
    expect(rec.status).toBe("in-revision");
    expect(rec.revisions).toHaveLength(1);
    expect(rec.revisions[0].feedback).toBe("keep this thread");
    expect(rec.revisions[0].targets).toEqual(original.targets);
  });

  it("preserves createdAt and advances updatedAt on revision", () => {
    const id = store.create(proposal()).id;
    const created = store.get(id)!;

    const revised = store.revise(id, "ask", v2());

    expect(revised.createdAt).toBe(created.createdAt);
    expect(Date.parse(revised.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.createdAt));
  });

  it("surfaces a revised proposal under the in-revision status query", () => {
    const id = store.create(proposal()).id;
    store.revise(id, "ask", v2());

    const found = store.query({ status: "in-revision" });
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(id);
    expect(found[0].revisions).toHaveLength(1);
  });

  it("refuses to revise an unknown proposal id", () => {
    expect(() => store.revise(9999, "ask", v2())).toThrow();
  });

  it("requires operator feedback — an empty ask is not a revision", () => {
    const id = store.create(proposal()).id;
    expect(() => store.revise(id, "", v2())).toThrow();
  });
});
