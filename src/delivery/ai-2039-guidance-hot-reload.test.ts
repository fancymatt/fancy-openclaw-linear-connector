/**
 * AI-2039 (P4-C4) — AC4.2: guidance hot-reload is VERIFIED, not assumed.
 *
 * FAILING integration test (write-tests state). Proves that a guidance edit
 * applied by the C4 apply pipeline (`src/proposal/apply-pipeline.ts`, not yet
 * built) is served on the NEXT wake read — through the real dispatch build path
 * (`buildDeliveryMessage` → `loadStepGuidance` → `fs.readFile`) — without a
 * restart and without any workflow-cache reset.
 *
 * Diagnosis carried into these tests (AC4.2 is deliberately branching):
 *   Step guidance is read FRESH from disk on every dispatch — `loadStepGuidance`
 *   in build-message.ts does `fs.readFile(<guidanceDir>/<wf>/<state>.md)` with no
 *   cache. So AC4.2 lands on the "fresh read on next wake" branch, NOT the
 *   "reads are cached → apply invalidates" branch. (Workflow-YAML defs ARE cached
 *   — that asymmetry is AC4.3, covered in ai-2039-apply-pipeline.test.ts.)
 *   These tests therefore prove fresh-read post-apply and assert that NO def-cache
 *   reset is performed for a guidance apply.
 *
 * Harness modeled on build-message-canon.test.ts.
 */

import { jest } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadWorkflowDefById, resetWorkflowCache } from "../workflow-gate.js";
import { resetPolicyCache } from "../escalation-gate.js";
import { _resetAppliedStateStore } from "../store/applied-state-store.js";

type ApplyModule = typeof import("../proposal/apply-pipeline.js");
async function loadApply(): Promise<ApplyModule> {
  return (await import("../proposal/apply-pipeline.js")) as ApplyModule;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const WORKFLOW_YAML = `id: dev-impl
version: 3
archetype: single-task
entry_state: write-tests
break_glass:
  command: escape
  to: escape
states:
  - id: write-tests
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: continue
        generic: continue
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: done
  - id: done
    kind: terminal
    native_state: done
  - id: escape
    kind: terminal
    native_state: invalid
`;

const POLICY_YAML = `capabilities:
  - id: linear:transition
containers:
  - id: dev
    grants: [linear:transition]
bodies:
  - id: igor
    container: dev
    fills_roles: [dev]
`;

const GUIDANCE_V1 = "# Step: write-tests\n\nORIGINAL guidance text — version one.\n";
const GUIDANCE_V2 = "# Step: write-tests\n\nUPDATED guidance text — version two, served after apply.\n";

function makeRoute(identifier: string, title: string): import("../types.js").RouteResult {
  return {
    agentId: "igor",
    sessionKey: `linear-${identifier}`,
    priority: 0,
    routingReason: "delegate",
    event: {
      type: "Issue",
      action: "update",
      actor: { id: "u1", name: "Ai", type: "user" },
      data: { identifier, title },
    } as unknown as import("../types.js").RouteResult["event"],
  };
}

function makeLabelFetch(labels: string[]): typeof globalThis.fetch {
  return async () =>
    new Response(
      JSON.stringify({ data: { issue: { labels: { nodes: labels.map((name) => ({ name })) } } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root });
}

// ── Setup / teardown ─────────────────────────────────────────────────────

let tmpDir: string;
let configRoot: string;
let guidanceDir: string;
let yamlPath: string;
let guidancePath: string;
let guidanceRel: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2039-hotreload-"));
  configRoot = tmpDir;
  guidanceDir = path.join(configRoot, "workflows");
  yamlPath = path.join(guidanceDir, "dev-impl.yaml");
  guidanceRel = path.join("workflows", "dev-impl", "write-tests.md");
  guidancePath = path.join(configRoot, guidanceRel);

  fs.mkdirSync(path.dirname(guidancePath), { recursive: true });
  fs.writeFileSync(yamlPath, WORKFLOW_YAML, "utf8");
  fs.writeFileSync(guidancePath, GUIDANCE_V1, "utf8");
  fs.writeFileSync(path.join(configRoot, "capability-policy.yaml"), POLICY_YAML, "utf8");

  git(configRoot, ["init", "-q"]);
  git(configRoot, ["config", "user.email", "tdd@fancymatt.local"]);
  git(configRoot, ["config", "user.name", "tdd"]);
  git(configRoot, ["add", "-A"]);
  git(configRoot, ["commit", "-q", "-m", "seed"]);

  resetWorkflowCache();
  resetPolicyCache();
  _resetAppliedStateStore();

  process.env.LINEAR_CONNECTOR_CONFIG_DIR = configRoot;
  process.env.WORKFLOW_DEF_PATH = yamlPath;
  process.env.WORKFLOW_GUIDANCE_DIR = guidanceDir;
  process.env.CAPABILITY_POLICY_PATH = path.join(configRoot, "capability-policy.yaml");
  originalFetch = globalThis.fetch;
  globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.LINEAR_CONNECTOR_CONFIG_DIR;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.WORKFLOW_GUIDANCE_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
  resetWorkflowCache();
  resetPolicyCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function buildMessage(): Promise<string> {
  const { buildDeliveryMessage } = await import("./build-message.js");
  return buildDeliveryMessage(makeRoute("AI-2039", "hot-reload test"), "Bearer tok");
}

function guidanceProposal(newContent: string) {
  const snapshot = fs.readFileSync(guidancePath, "utf8");
  const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  const targets = [
    { kind: "guidance" as const, path: guidanceRel, oldContent: { hash: sha(snapshot), snapshot }, newContent, diff: `edit ${guidanceRel}` },
  ];
  const key = sha(targets.map((t) => sha(t.path) + sha(t.diff)).join(""));
  return { id: "hot-reload-prop", idempotencyKey: key, targets };
}

function applyDeps() {
  return {
    configRoot,
    store: (() => {
      const rows = new Map<string, unknown>();
      return { rows, getByIdempotencyKey: (k: string) => rows.get(k) ?? null, record: (r: { idempotencyKey: string }) => rows.set(r.idempotencyKey, r) };
    })(),
    captureMetrics: () => ({ snapshot: {}, window: { since: "2026-06-10T00:00:00.000Z", until: "2026-07-10T00:00:00.000Z" } }),
    reloadWorkflowDefs: jest.fn(),
    now: () => 1_752_100_000_000,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("AC4.2 — a guidance edit is served on the next wake read without restart", () => {
  it("the wake dispatch initially serves the pre-apply guidance", async () => {
    // Loading the (not-yet-existent) apply module first makes this suite enumerate
    // red per-AC rather than passing against the already-fresh read path.
    await loadApply();
    const msg = await buildMessage();
    expect(msg).toContain("ORIGINAL guidance text — version one.");
  });

  it("after the apply pipeline writes the guidance edit, the NEXT wake read serves it — no restart, no cache reset", async () => {
    const { applyProposal } = await loadApply();

    const before = await buildMessage();
    expect(before).toContain("ORIGINAL guidance text — version one.");

    // Capture the live def reference so we can prove the connector was NOT restarted.
    const defBefore = await loadWorkflowDefById("dev-impl");

    const res = await applyProposal(guidanceProposal(GUIDANCE_V2), applyDeps());
    expect(res.status).toBe("applied");

    // No resetWorkflowCache() call here — guidance must be picked up on a plain read.
    const after = await buildMessage();
    expect(after).toContain("UPDATED guidance text — version two, served after apply.");
    expect(after).not.toContain("ORIGINAL guidance text — version one.");

    // "Without restart": the cached workflow def object is the very same instance.
    const defAfter = await loadWorkflowDefById("dev-impl");
    expect(defAfter).toBe(defBefore);
  });

  it("a second guidance apply is likewise served on the next read (fresh-read is not a one-shot)", async () => {
    const { applyProposal } = await loadApply();
    await applyProposal(guidanceProposal(GUIDANCE_V2), applyDeps());
    expect(await buildMessage()).toContain("version two");

    const third = "# Step: write-tests\n\nTHIRD revision of the guidance.\n";
    await applyProposal(guidanceProposal(third), applyDeps());
    const msg = await buildMessage();
    expect(msg).toContain("THIRD revision of the guidance.");
    expect(msg).not.toContain("version two");
  });
});
