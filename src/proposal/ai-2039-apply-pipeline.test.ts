/**
 * AI-2039 (P4-C4) — Apply pipeline: atomic, TOCTOU-guarded, versioned applies.
 *
 * FAILING tests (TDD, write-tests state). The module under test
 * (`src/proposal/apply-pipeline.ts`) does not exist yet — the implementer
 * (Igor) makes these pass.
 *
 * Contract source of truth:
 *   - AC of record: AI-2039 verbatim AC4.1–4.8 (captured by astrid 2026-07-10T05:03Z).
 *   - Proposal object shape: AI-2038 AC3.1 as AMENDED 2026-07-10T06:04Z (`targets[]`
 *     core; each target `{ kind, path, oldContent:{hash,snapshot}, newContent, diff }`;
 *     non-empty, sorted asc by path; `idempotencyKey =
 *     sha256hex(concat(sortedTargets.map(t => sha256hex(t.path) + sha256hex(t.diff))))`).
 *     This suite deliberately builds against the `targets[]` shape, NOT the
 *     superseded v1 singular shape that got C3's earlier suite escaped.
 *   - Downstream API contract already merged in C5 (AI-2040, PR #203):
 *     `GET /admin/api/proposals` + `POST /admin/api/proposals/:id/retry-apply`,
 *     status enum includes `apply-failed`. See ai-2039-apply-api.test.ts.
 *
 * These tests observe REAL side effects (a real git repo as the instance config
 * root; real temp files) rather than asserting internal shape, so the implementer
 * keeps latitude on internals while the AC-load-bearing behavior is pinned.
 */

import { jest } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Lazy loader (AI-2009 pattern) ──────────────────────────────────────────
// isolatedModules + a not-yet-existent module would fail suite COLLECTION as a
// single error. Importing lazily inside each test makes every AC enumerate as an
// individual red with a per-AC name, so ac-validate can trace coverage.
type ApplyModule = typeof import("./apply-pipeline.js");
async function loadApply(): Promise<ApplyModule> {
  return (await import("./apply-pipeline.js")) as ApplyModule;
}

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** idempotencyKey per AI-2038 AC3.1 (amended): hash-per-field over path-sorted targets. */
function idempotencyKey(targets: Array<{ path: string; diff: string }>): string {
  const sorted = [...targets].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256hex(sorted.map((t) => sha256hex(t.path) + sha256hex(t.diff)).join(""));
}

// ── Test rig: a real git-tracked instance config root ──────────────────────

const DEV_IMPL_YAML_V3 = `id: dev-impl
version: 3
entry_state: intake
states:
  - id: write-tests
    owner_role: test-author
  - id: implementation
    owner_role: dev
`;

const GUIDANCE_V1 = `# Step: write-tests

Write failing tests covering all in-scope AC.
`;

interface Rig {
  root: string;
  yamlPath: string; // absolute
  yamlRel: string; // relative to root
  guidancePath: string; // absolute
  guidanceRel: string; // relative to root
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function makeRig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai2039-apply-"));
  const yamlRel = path.join("workflows", "dev-impl.yaml");
  const guidanceRel = path.join("workflows", "dev-impl", "write-tests.md");
  const yamlPath = path.join(root, yamlRel);
  const guidancePath = path.join(root, guidanceRel);
  fs.mkdirSync(path.dirname(guidancePath), { recursive: true });
  fs.writeFileSync(yamlPath, DEV_IMPL_YAML_V3, "utf8");
  fs.writeFileSync(guidancePath, GUIDANCE_V1, "utf8");

  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "tdd@fancymatt.local"]);
  git(root, ["config", "user.name", "tdd"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed instance config"]);

  return { root, yamlPath, yamlRel, guidancePath, guidanceRel };
}

/** A minimal in-memory ApplyStore for tests; keyed by idempotencyKey. */
function makeStore() {
  const rows = new Map<string, unknown>();
  return {
    rows,
    getByIdempotencyKey: (key: string) => rows.get(key) ?? null,
    record: (rec: { idempotencyKey: string }) => {
      rows.set(rec.idempotencyKey, rec);
    },
  };
}

const FIXED_METRICS_BASELINE = {
  snapshot: {
    items: [{ workflow: "dev-impl", step: "write-tests", reasonCode: "missing-tests", count: 14, exceedsThreshold: true }],
    summary: { totalObservations: 14, uniqueWorkflows: 1, uniqueSteps: 1, stepsAboveThreshold: [] },
    query: {},
  },
  window: { since: "2026-06-10T00:00:00.000Z", until: "2026-07-10T00:00:00.000Z" },
};

/** Build a proposal with real hashes/snapshots tied to the current on-disk files. */
function makeGuidanceProposal(rig: Rig, newContent: string) {
  const snapshot = fs.readFileSync(rig.guidancePath, "utf8");
  const diff = `--- a/${rig.guidanceRel}\n+++ b/${rig.guidanceRel}\n@@\n-${snapshot}\n+${newContent}\n`;
  const targets = [
    {
      kind: "guidance" as const,
      path: rig.guidanceRel,
      oldContent: { hash: sha256hex(snapshot), snapshot },
      newContent,
      diff,
    },
  ];
  return { id: "prop-guidance-1", idempotencyKey: idempotencyKey(targets), targets, evidenceCluster: { failureType: "missing-tests", occurrences: 14, ticketIds: ["AI-1", "AI-2"] } };
}

// NOTE: the version field is pipeline-managed (AC4.6). A YAML target's newContent
// carries the semantic change only and leaves `version:` untouched; the apply
// increments it. Callers pass semantic newContent that does NOT pre-bump version.
function makeYamlProposal(rig: Rig, newContent: string) {
  const snapshot = fs.readFileSync(rig.yamlPath, "utf8");
  const diff = `--- a/${rig.yamlRel}\n+++ b/${rig.yamlRel}\n@@\n changed\n`;
  const targets = [
    {
      kind: "yaml" as const,
      path: rig.yamlRel,
      oldContent: { hash: sha256hex(snapshot), snapshot },
      newContent,
      diff,
    },
  ];
  return { id: "prop-yaml-1", idempotencyKey: idempotencyKey(targets), targets };
}

function baseDeps(rig: Rig, store: ReturnType<typeof makeStore>, overrides: Record<string, unknown> = {}) {
  return {
    configRoot: rig.root,
    store,
    captureMetrics: () => FIXED_METRICS_BASELINE,
    reloadWorkflowDefs: jest.fn(),
    now: () => 1_752_100_000_000, // fixed clock (Date.now() is banned in some modules)
    ...overrides,
  };
}

let rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs) fs.rmSync(r.root, { recursive: true, force: true });
  rigs = [];
});
function newRig(): Rig {
  const r = makeRig();
  rigs.push(r);
  return r;
}

// ── AC4.1 — atomic write (temp + rename); no torn read; no temp leftovers ──

describe("AC4.1 — applies write atomically (temp + rename)", () => {
  it("target file ends up byte-identical to newContent after apply", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    const newContent = GUIDANCE_V1 + "\nAdded line for AC4.1.\n";
    const res = await applyProposal(makeGuidanceProposal(rig, newContent), baseDeps(rig, store));
    expect(res.status).toBe("applied");
    expect(fs.readFileSync(rig.guidancePath, "utf8")).toBe(newContent);
  });

  it("a concurrent reader never observes a torn file — only old OR new, never a mix", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    // Large payload widens the torn-read window a non-atomic (truncate+write) impl would expose.
    const oldContent = fs.readFileSync(rig.guidancePath, "utf8");
    const newContent = "NEW\n" + "x".repeat(2 * 1024 * 1024) + "\nEND-NEW\n";
    const oldHash = sha256hex(oldContent);
    const newHash = sha256hex(newContent);

    let stop = false;
    const observed = new Set<string>();
    const reader = (async () => {
      while (!stop) {
        try {
          observed.add(sha256hex(fs.readFileSync(rig.guidancePath, "utf8")));
        } catch {
          observed.add("READ-ERROR"); // ENOENT during a rename gap is itself a torn-read failure
        }
        // AI-2039 (Igor, implementer): yield to the event loop each iteration.
        // The original loop was a tight *synchronous* while() with no await, which
        // starves the event loop so the awaited async applyProposal below never
        // runs — the test deadlocks before the apply is even invoked (verified:
        // hangs under a correct impl too). A per-iteration yield makes the reader
        // genuinely concurrent with the apply while fully preserving the assertion:
        // a non-atomic (truncate+write) impl would still expose a torn read here.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();

    await applyProposal(makeGuidanceProposal(rig, newContent), baseDeps(rig, store));
    stop = true;
    await reader;

    for (const h of observed) {
      expect([oldHash, newHash]).toContain(h);
    }
    expect(observed.has(newHash)).toBe(true);
  });

  it("leaves no temp/partial files behind in the target directory", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    await applyProposal(makeGuidanceProposal(rig, GUIDANCE_V1 + "\nz\n"), baseDeps(rig, store));
    const entries = fs.readdirSync(path.dirname(rig.guidancePath));
    expect(entries).toEqual(["write-tests.md"]);
  });
});

// ── AC4.3 — YAML applies invalidate the def cache (no full restart) ─────────
//    Guidance applies do NOT need a reload (guidance is fresh-read every wake —
//    proven separately in ai-2039-guidance-hot-reload.test.ts).

describe("AC4.3 — workflow-YAML applies trigger an explicit def reload, guidance does not", () => {
  it("a YAML-target apply calls reloadWorkflowDefs (def-cache invalidation, no restart)", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    const deps = baseDeps(rig, store);
    const res = await applyProposal(makeYamlProposal(rig, DEV_IMPL_YAML_V3 + "# touched by AI-2039\n"), deps);
    expect(res.status).toBe("applied");
    expect(deps.reloadWorkflowDefs).toHaveBeenCalledTimes(1);
  });

  it("a guidance-only apply does NOT trigger a def reload (guidance is served fresh)", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    const deps = baseDeps(rig, store);
    await applyProposal(makeGuidanceProposal(rig, GUIDANCE_V1 + "\nnew\n"), deps);
    expect(deps.reloadWorkflowDefs).not.toHaveBeenCalled();
  });
});

// ── AC4.4 — TOCTOU guard: re-hash current file; mismatch → refuse + stale ───

describe("AC4.4 — TOCTOU guard (re-hash current file against old_content hash)", () => {
  it("refuses and marks the proposal stale when a manual edit landed after generation", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    const proposal = makeGuidanceProposal(rig, GUIDANCE_V1 + "\nfrom-proposal\n");

    // A manual edit lands between generation and approval — current hash now differs.
    const tampered = GUIDANCE_V1 + "\nMANUAL EDIT that the proposal never saw\n";
    fs.writeFileSync(rig.guidancePath, tampered, "utf8");

    const res = await applyProposal(proposal, baseDeps(rig, store));

    expect(res.status).toBe("stale");
    expect(res.staleTargets).toContain(rig.guidanceRel);
    // The manual edit must be preserved — apply is a no-op on mismatch.
    expect(fs.readFileSync(rig.guidancePath, "utf8")).toBe(tampered);
  });

  it("does NOT commit or bump version on a stale refusal", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    const proposal = makeGuidanceProposal(rig, GUIDANCE_V1 + "\nx\n");
    fs.writeFileSync(rig.guidancePath, GUIDANCE_V1 + "\ntampered\n", "utf8");

    const headBefore = git(rig.root, ["rev-parse", "HEAD"]);
    await applyProposal(proposal, baseDeps(rig, store));

    expect(git(rig.root, ["rev-parse", "HEAD"])).toBe(headBefore); // no new commit
    expect(fs.readFileSync(rig.yamlPath, "utf8")).toContain("version: 3"); // no bump
  });

  it("proceeds when the current file still matches the captured old_content hash", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    const res = await applyProposal(makeGuidanceProposal(rig, GUIDANCE_V1 + "\nfresh\n"), baseDeps(rig, store));
    expect(res.status).toBe("applied");
  });
});

// ── AC4.5 — idempotency: same proposal twice → one apply, one version bump ──

describe("AC4.5 — idempotency", () => {
  it("applying the same proposal twice yields exactly one commit and one version bump", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    const proposal = makeGuidanceProposal(rig, GUIDANCE_V1 + "\nidempotent\n");

    const first = await applyProposal(proposal, baseDeps(rig, store));
    expect(first.status).toBe("applied");
    expect(first.alreadyApplied ?? false).toBe(false);
    const headAfterFirst = git(rig.root, ["rev-parse", "HEAD"]);
    const versionAfterFirst = fs.readFileSync(rig.yamlPath, "utf8");
    expect(versionAfterFirst).toContain("version: 4");

    const second = await applyProposal(proposal, baseDeps(rig, store));
    expect(second.status).toBe("applied");
    expect(second.alreadyApplied).toBe(true); // idempotent no-op

    expect(git(rig.root, ["rev-parse", "HEAD"])).toBe(headAfterFirst); // no second commit
    expect(fs.readFileSync(rig.yamlPath, "utf8")).toContain("version: 4"); // no second bump
    // git log must show exactly one apply commit on top of the seed.
    const commitCount = Number(git(rig.root, ["rev-list", "--count", "HEAD"]));
    expect(commitCount).toBe(2); // seed + one apply
  });

  it("concurrent applies of the same proposal (double-click) result in exactly one apply", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    const proposal = makeGuidanceProposal(rig, GUIDANCE_V1 + "\nconcurrent\n");
    const deps = baseDeps(rig, store);

    const results = await Promise.all([applyProposal(proposal, deps), applyProposal(proposal, deps)]);

    const winners = results.filter((r) => r.status === "applied" && !r.alreadyApplied);
    expect(winners).toHaveLength(1); // exactly one real apply
    const commitCount = Number(git(rig.root, ["rev-list", "--count", "HEAD"]));
    expect(commitCount).toBe(2); // seed + exactly one apply, not two
    expect(fs.readFileSync(rig.yamlPath, "utf8")).toContain("version: 4"); // bumped once
  });
});

// ── AC4.6 — version bump + git commit in config dir; rollback via git revert ─

describe("AC4.6 — version increment + git commit + git-revert rollback", () => {
  it("increments the workflow def YAML version and commits the change to git", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    const headBefore = git(rig.root, ["rev-parse", "HEAD"]);

    const res = await applyProposal(makeGuidanceProposal(rig, GUIDANCE_V1 + "\ncommitted\n"), baseDeps(rig, store));

    expect(res.status).toBe("applied");
    expect(res.version).toBe(4);
    expect(fs.readFileSync(rig.yamlPath, "utf8")).toContain("version: 4");
    // A new commit exists and touches both the guidance file and the version-bumped def.
    expect(git(rig.root, ["rev-parse", "HEAD"])).not.toBe(headBefore);
    const changed = git(rig.root, ["show", "--name-only", "--pretty=format:", "HEAD"]).split("\n").filter(Boolean);
    expect(changed).toEqual(expect.arrayContaining([rig.guidanceRel, rig.yamlRel]));
    // Working tree is clean after the apply (everything committed, nothing dangling).
    expect(git(rig.root, ["status", "--porcelain"])).toBe("");
  });

  it("git revert of the apply commit restores prior content AND prior version", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    const originalGuidance = fs.readFileSync(rig.guidancePath, "utf8");

    await applyProposal(makeGuidanceProposal(rig, GUIDANCE_V1 + "\nwill-be-reverted\n"), baseDeps(rig, store));
    expect(fs.readFileSync(rig.yamlPath, "utf8")).toContain("version: 4");

    git(rig.root, ["revert", "--no-edit", "HEAD"]);

    expect(fs.readFileSync(rig.guidancePath, "utf8")).toBe(originalGuidance);
    expect(fs.readFileSync(rig.yamlPath, "utf8")).toContain("version: 3"); // version restored
  });
});

// ── AC4.7 — baseline metrics snapshot stored with the applied proposal ──────

describe("AC4.7 — baseline capture at apply time", () => {
  it("captures the cluster metrics snapshot + observation window and stores it on the applied record", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    const captureMetrics = jest.fn(() => FIXED_METRICS_BASELINE);
    const proposal = makeGuidanceProposal(rig, GUIDANCE_V1 + "\nbaseline\n");

    const res = await applyProposal(proposal, baseDeps(rig, store, { captureMetrics }));

    expect(captureMetrics).toHaveBeenCalledTimes(1);
    expect(res.metricsBaseline).toEqual(FIXED_METRICS_BASELINE);
    expect(res.metricsBaseline?.window).toEqual({ since: expect.any(String), until: expect.any(String) });

    // Snapshot is persisted with the proposal so before/after is computable at pilot.
    const stored = store.getByIdempotencyKey(proposal.idempotencyKey) as { metricsBaseline?: unknown } | null;
    expect(stored).not.toBeNull();
    expect(stored?.metricsBaseline).toEqual(FIXED_METRICS_BASELINE);
  });

  it("does not capture a baseline when the apply is refused as stale", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    const captureMetrics = jest.fn(() => FIXED_METRICS_BASELINE);
    const proposal = makeGuidanceProposal(rig, GUIDANCE_V1 + "\nx\n");
    fs.writeFileSync(rig.guidancePath, GUIDANCE_V1 + "\ntampered\n", "utf8");

    const res = await applyProposal(proposal, baseDeps(rig, store, { captureMetrics }));
    expect(res.status).toBe("stale");
    expect(captureMetrics).not.toHaveBeenCalled();
  });
});

// ── AC4.8 — apply failure surfaces apply-failed + retry succeeds ────────────

describe("AC4.8 — apply failure → apply-failed status + retry affordance", () => {
  it("returns status apply-failed (retryable) and does not half-write when the git commit fails", async () => {
    const { applyProposal } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    const original = fs.readFileSync(rig.guidancePath, "utf8");
    // Break git so the commit step fails partway through the apply.
    fs.rmSync(path.join(rig.root, ".git"), { recursive: true, force: true });

    const res = await applyProposal(makeGuidanceProposal(rig, GUIDANCE_V1 + "\nboom\n"), baseDeps(rig, store));

    expect(res.status).toBe("apply-failed");
    expect(res.retryable).toBe(true);
    expect(typeof res.error).toBe("string");
    // A failed apply must not leave a half-applied file uncommitted.
    expect(fs.readFileSync(rig.guidancePath, "utf8")).toBe(original);
    const stored = store.getByIdempotencyKey(makeGuidanceProposal(rig, GUIDANCE_V1 + "\nboom\n").idempotencyKey) as { status?: string } | null;
    expect(stored?.status).toBe("apply-failed");
  });

  it("retryApply re-runs a previously failed apply and succeeds once the fault clears", async () => {
    const { applyProposal, retryApply } = await loadApply();
    const rig = newRig();
    const store = makeStore();
    const proposal = makeGuidanceProposal(rig, GUIDANCE_V1 + "\nretry\n");

    // First attempt fails (git broken).
    const gitBackup = path.join(rig.root, ".git");
    const stash = path.join(os.tmpdir(), "ai2039-git-stash-" + process.pid);
    fs.renameSync(gitBackup, stash);
    const failed = await applyProposal(proposal, baseDeps(rig, store));
    expect(failed.status).toBe("apply-failed");

    // Fault clears; operator hits retry.
    fs.renameSync(stash, gitBackup);
    const retried = await retryApply(proposal, baseDeps(rig, store));

    expect(retried.status).toBe("applied");
    expect(fs.readFileSync(rig.guidancePath, "utf8")).toBe(GUIDANCE_V1 + "\nretry\n");
    // A successful retry still bumps the version exactly once (not once per attempt).
    expect(fs.readFileSync(rig.yamlPath, "utf8")).toContain("version: 4");
  });
});
