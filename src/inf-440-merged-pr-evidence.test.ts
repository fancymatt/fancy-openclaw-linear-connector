/**
 * INF-440 — Merged PR evidence recognition.
 *
 * AC of record:
 *  1. The evidence-gathering logic (connector) correctly identifies PRs in
 *     `merged` state as evidence for `implementation` completion.
 *  2. The evidence-gathering logic correctly identifies branches already
 *     merged into `main` (ancestors of `main`) as evidence.
 *  3. When evidence is found via a merged PR/branch, the ticket advances to
 *     `ac-validate` (or the next logical review state) instead of bouncing
 *     to `intake`/`write-tests`.
 *  4. [Bootstrap-wiring] The component is registered at server bootstrap
 *     (reachable from the production entry point, e.g. `index.ts`), proven
 *     by an integration test that boots the entry point and asserts
 *     registration. A module-level unit test does NOT satisfy this.
 *  5. Liveness is observable at ac-validate without waiting for the
 *     component's trigger condition: a `/health` field, startup log line,
 *     or registry entry showing the component is scheduled/subscribed.
 *
 * All tests in this file MUST be RED until the feature is implemented:
 *  - `src/merged-pr-evidence.ts` does not exist yet (AC1-3).
 *  - `src/cron/merged-evidence-reconciler-cron.ts` does not exist yet, and
 *    index.ts does not import/call a registrar for it (AC4-5).
 *
 * Pattern mirrors src/ai-1857-rescue-sweep-bootstrap.test.ts (bootstrap-wiring
 * proof) and src/cron/done-ticket-detector.test.ts (evidence-gathering unit
 * tests with mocked GitHub/Linear interactions).
 */

import { jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// ══════════════════════════════════════════════════════════════════════════
// AC1 + AC2 + AC3: evidence-gathering + routing decision (module-level unit)
// ══════════════════════════════════════════════════════════════════════════
//
// NOTE: `src/merged-pr-evidence.ts` does not exist yet. This import fails at
// module-resolution time, which is expected — it is what makes this suite RED
// until the module is implemented. The shape below is the interface the
// implementation is expected to satisfy.

import {
  detectMergedEvidence,
  resolveEvidenceTransition,
  type MergedEvidenceResult,
} from "./merged-pr-evidence.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("INF-440 AC1: merged PR is recognized as implementation evidence", () => {
  let fetchSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch" as never);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns hasMergedPR=true when Linear reports a GitHub PR attachment with status 'merged'", async () => {
    fetchSpy.mockImplementation((async () =>
      ({
        json: async () => ({
          data: {
            issue: {
              attachments: {
                nodes: [
                  {
                    url: "https://github.com/acme/repo/pull/42",
                    sourceType: "github",
                    metadata: { status: "merged" },
                  },
                ],
              },
            },
          },
        }),
      })) as unknown as typeof fetch);

    const result: MergedEvidenceResult = await detectMergedEvidence("issue-1", "Bearer tok", {
      repoDir: __dirname,
      branchName: null,
    });

    expect(result.hasMergedPR).toBe(true);
  });

  it("returns hasMergedPR=false when the PR attachment is open (not merged)", async () => {
    fetchSpy.mockImplementation((async () =>
      ({
        json: async () => ({
          data: {
            issue: {
              attachments: {
                nodes: [
                  {
                    url: "https://github.com/acme/repo/pull/43",
                    sourceType: "github",
                    metadata: { status: "open" },
                  },
                ],
              },
            },
          },
        }),
      })) as unknown as typeof fetch);

    const result = await detectMergedEvidence("issue-2", "Bearer tok", {
      repoDir: __dirname,
      branchName: null,
    });

    expect(result.hasMergedPR).toBe(false);
  });
});

describe("INF-440 AC2: branches already merged into main are recognized as evidence", () => {
  let dir: string;
  let fetchSpy: ReturnType<typeof jest.spyOn>;

  beforeAll(() => {
    // A minimal real git repo so `git merge-base --is-ancestor` has a real
    // ref graph to check against — avoids over-mocking child_process.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-440-git-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.txt"), "1");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

    // A branch merged into main.
    execFileSync("git", ["checkout", "-q", "-b", "feature/merged-branch"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "b.txt"), "2");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "feature work"], { cwd: dir });
    execFileSync("git", ["checkout", "-q", "main"], { cwd: dir });
    execFileSync("git", ["merge", "-q", "--no-ff", "feature/merged-branch", "-m", "merge"], { cwd: dir });

    // A branch NOT merged into main.
    execFileSync("git", ["checkout", "-q", "-b", "feature/unmerged-branch"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "c.txt"), "3");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "unmerged work"], { cwd: dir });
    execFileSync("git", ["checkout", "-q", "main"], { cwd: dir });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch" as never);
    // No PR evidence at all for these cases — evidence must come from git ancestry.
    fetchSpy.mockImplementation((async () =>
      ({
        json: async () => ({ data: { issue: { attachments: { nodes: [] } } } }),
      })) as unknown as typeof fetch);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns hasMergedBranch=true when the ticket's branch is an ancestor of main", async () => {
    const result = await detectMergedEvidence("issue-3", "Bearer tok", {
      repoDir: dir,
      branchName: "feature/merged-branch",
    });

    expect(result.hasMergedBranch).toBe(true);
  });

  it("returns hasMergedBranch=false when the ticket's branch is not merged into main", async () => {
    const result = await detectMergedEvidence("issue-4", "Bearer tok", {
      repoDir: dir,
      branchName: "feature/unmerged-branch",
    });

    expect(result.hasMergedBranch).toBe(false);
  });
});

describe("INF-440 AC3: evidence found routes to ac-validate instead of bouncing to intake/write-tests", () => {
  const merged: MergedEvidenceResult = { hasMergedPR: true, hasMergedBranch: false };
  const mergedBranchOnly: MergedEvidenceResult = { hasMergedPR: false, hasMergedBranch: true };
  const noEvidence: MergedEvidenceResult = { hasMergedPR: false, hasMergedBranch: false };

  it("routes 'intake' with merged-PR evidence to ac-validate", () => {
    expect(resolveEvidenceTransition("intake", merged)).toBe("ac-validate");
  });

  it("routes 'write-tests' with merged-PR evidence to ac-validate", () => {
    expect(resolveEvidenceTransition("write-tests", merged)).toBe("ac-validate");
  });

  it("routes 'intake' with merged-branch-ancestor evidence to ac-validate", () => {
    expect(resolveEvidenceTransition("intake", mergedBranchOnly)).toBe("ac-validate");
  });

  it("does NOT override the bounce to intake when there is no merged evidence", () => {
    expect(resolveEvidenceTransition("intake", noEvidence)).toBeNull();
  });

  it("does NOT override the bounce to write-tests when there is no merged evidence", () => {
    expect(resolveEvidenceTransition("write-tests", noEvidence)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC4 + AC5: bootstrap-wiring — component registered at server bootstrap,
// liveness observable at /health without waiting for the trigger condition.
//
// NOTE: `src/cron/merged-evidence-reconciler-cron.ts` does not exist yet, and
// index.ts does not import/call a registrar for it. This import + the static
// source-scan below are both expected to fail (RED) until implemented.
// ══════════════════════════════════════════════════════════════════════════

import { registerMergedEvidenceReconcilerCron } from "./cron/merged-evidence-reconciler-cron.js";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { resetCronRegistryForTest } from "./cron/registry.js";
import request from "supertest";

const INDEX_TS = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition]
roles:
  - id: steward
    requires: [linear:transition]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [{ name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" }],
    }),
    "utf8",
  );
  return file;
}

function writePolicyFile(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(file, TEST_POLICY_YAML, "utf8");
  return file;
}

describe("INF-440 AC4 static: merged-evidence reconciler is imported and called in index.ts", () => {
  it("imports registerMergedEvidenceReconcilerCron from the cron module", () => {
    expect(
      INDEX_TS.includes(
        'import { registerMergedEvidenceReconcilerCron } from "./cron/merged-evidence-reconciler-cron.js"',
      ),
    ).toBe(true);
  });

  it("calls registerMergedEvidenceReconcilerCron() in the bootstrap block", () => {
    expect(INDEX_TS.includes("registerMergedEvidenceReconcilerCron(")).toBe(true);
  });
});

describe("INF-440 AC5 runtime: merged-evidence reconciler is observable via /health crons field", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-440-bootstrap-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    process.env.MERGED_EVIDENCE_RECONCILER_INTERVAL = "999999h"; // prevent timer fires
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    resetCronRegistryForTest();
    reloadAgents();

    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    registerMergedEvidenceReconcilerCron();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.MERGED_EVIDENCE_RECONCILER_INTERVAL;
  });

  it("/health crons array includes merged-evidence-reconciler with schedule and registeredAt", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const crons = body.crons as Array<{ name: string; schedule: string; registeredAt: string }>;

    expect(Array.isArray(crons)).toBe(true);
    const entry = crons.find((c) => c.name === "merged-evidence-reconciler");
    expect(entry).toBeDefined();
    expect(entry!.schedule.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(entry!.registeredAt))).toBe(false);
  });

  it("merged-evidence-reconciler cron entry proves it is scheduled (not just imported)", async () => {
    const res = await request(appState.app).get("/health");
    const body = res.body as Record<string, unknown>;
    const crons = body.crons as Array<{ name: string; schedule: string }>;

    const entry = crons.find((c) => c.name === "merged-evidence-reconciler");
    expect(entry!.schedule).toMatch(/\d+\s*(h|m|s|ms|d)/);
  });
});
