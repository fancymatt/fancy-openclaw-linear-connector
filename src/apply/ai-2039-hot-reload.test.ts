/**
 * AI-2039 (P4-C4) — AC4.2: guidance hot-reload is VERIFIED, not assumed.
 *
 * AC coverage in this file:
 *   AC4.2 — an integration test proves a guidance edit is served on the next
 *           wake read without restart. If reads turn out to be cached, apply
 *           triggers explicit invalidation and the test proves that instead.
 *
 * ── Diagnosis (this is the load-bearing finding; Igor's #1 scope risk) ──────
 * The two config artifacts the apply pipeline touches have OPPOSITE read
 * semantics. This was traced, not assumed:
 *
 *   Step guidance (workflows/<wf>/<state>.md)
 *     src/delivery/build-message.ts loadStepGuidance() → `await fs.readFile(...)`
 *     on every call, and guidanceDir() re-reads the env var on every call.
 *     There is NO cache. => AC4.2 takes the FIRST branch: prove fresh-read on
 *     the next wake. No invalidation hook is needed for guidance.
 *
 *   Workflow YAML defs (workflows/<wf>.yaml)
 *     src/workflow-gate.ts holds a module-level `_registryCache`, cleared only
 *     by resetWorkflowCache(). This IS cached. => that is what AC4.3's reload
 *     endpoint exists for. Covered in ai-2039-apply-api.test.ts.
 *
 * The first two tests below are the diagnosis, pinned as regression guards:
 * they characterize the read paths that AC4.2's branch choice depends on. They
 * pass today. If someone later adds a guidance cache without an invalidation
 * hook, the first one goes red and AC4.2's branch must be re-decided.
 *
 * The AC4.2 test proper goes through ApplyPipeline (RED until it exists) and
 * the REAL wake read path (buildDeliveryMessage), so a pipeline that writes to
 * the wrong directory, or that is never wired to the guidance dir at all, fails
 * here rather than passing a unit test in isolation.
 *
 * ── Contract the implementer conforms to ────────────────────────────────────
 * See apply-pipeline.test.ts for the full ApplyPipeline / ApplyLedger contract.
 *
 * RED until src/apply/apply-pipeline.ts exists.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { resetWorkflowCache, loadWorkflowDefById } from "../workflow-gate.js";
import { resetPolicyCache } from "../escalation-gate.js";
import { ObservationStore } from "../store/observation-store.js";
import { ProposalStore } from "../proposal/proposal-store.js";
import type { GeneratedProposal } from "../proposal/proposal-generator.js";
import { ApplyPipeline } from "./apply-pipeline.js";
import type { RouteResult } from "../types.js";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const WORKFLOW_YAML = `
id: dev-impl
version: 3
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  to: escape

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: code-review

  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: done

  - id: done
    owner_role: steward
    kind: terminal
    native_state: done
    transitions: []

  - id: escape
    owner_role: steward
    kind: normal
    native_state: todo
    transitions: []
`;

const POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: dev
    grants: [linear:transition]
bodies:
  - id: charles
    container: dev
    fills_roles: [steward, code-review, dev]
`;

const OLD_GUIDANCE = "# Step: code-review\n\nAlways check the diff.\n";
const NEW_GUIDANCE = "# Step: code-review\n\nAlways check the diff AND run the tests.\n";

let configRoot: string;
let dataDir: string;
let observations: ObservationStore;
let proposals: ProposalStore;
let originalFetch: typeof globalThis.fetch;

function guidancePath(state = "code-review"): string {
  return path.join(configRoot, "workflows", "dev-impl", `${state}.md`);
}

function makeLabelFetch(labels: string[]): typeof globalThis.fetch {
  return async () =>
    new Response(
      JSON.stringify({ data: { issue: { labels: { nodes: labels.map((name) => ({ name })) } } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

function makeRoute(identifier: string, title: string): RouteResult {
  return {
    agentId: "charles",
    sessionKey: `linear-${identifier}`,
    priority: 0,
    routingReason: "delegate",
    event: {
      type: "Issue",
      action: "update",
      actor: { id: "u1", name: "Ai", type: "user" },
      data: { identifier, title },
    },
  } as unknown as RouteResult;
}

/** Build a wake message through the real delivery path (fresh module each call). */
async function wakeMessage(): Promise<string> {
  globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
  const mod = await import("../delivery/build-message.js");
  return mod.buildDeliveryMessage(makeRoute("AI-2039", "Apply pipeline"), "Bearer tok");
}

function seedProposal(over: Partial<GeneratedProposal> = {}): GeneratedProposal {
  const diff = `--- a\n+++ b\n@@\n-${OLD_GUIDANCE}\n+${NEW_GUIDANCE}\n`;
  return {
    workflowId: "dev-impl",
    stateId: "code-review",
    oldContent: { hash: sha256(OLD_GUIDANCE), snapshot: OLD_GUIDANCE },
    newContent: NEW_GUIDANCE,
    diff,
    confidenceScore: 0.8,
    evidenceCluster: { ticketIds: ["AI-1001"], counts: { "missing-tests": 7 } },
    failureCount: 7,
    version: 3,
    idempotencyKey: sha256(diff),
    ...over,
  };
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: configRoot, encoding: "utf8" }).trim();
}

beforeEach(() => {
  configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai2039-reload-cfg-"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2039-reload-data-"));

  fs.mkdirSync(path.join(configRoot, "workflows", "dev-impl"), { recursive: true });
  fs.mkdirSync(path.join(configRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(configRoot, "workflows", "dev-impl.yaml"), WORKFLOW_YAML, "utf8");
  fs.writeFileSync(path.join(configRoot, "config", "capability-policy.yaml"), POLICY_YAML, "utf8");
  fs.writeFileSync(guidancePath(), OLD_GUIDANCE, "utf8");

  // The instance config dir is git-tracked (AC4.6).
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "tdd@fancymatt.test");
  git("config", "user.name", "tdd");
  git("add", "-A");
  git("commit", "--quiet", "-m", "baseline");

  process.env.LINEAR_CONNECTOR_CONFIG_DIR = configRoot;
  process.env.WORKFLOW_DEF_PATH = path.join(configRoot, "workflows", "dev-impl.yaml");
  process.env.WORKFLOW_GUIDANCE_DIR = path.join(configRoot, "workflows");
  process.env.CAPABILITY_POLICY_PATH = path.join(configRoot, "config", "capability-policy.yaml");

  resetWorkflowCache();
  resetPolicyCache();

  observations = new ObservationStore(path.join(dataDir, "observations.db"));
  proposals = new ProposalStore(path.join(dataDir, "proposals.db"));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  observations.close();
  proposals.close();
  delete process.env.LINEAR_CONNECTOR_CONFIG_DIR;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.WORKFLOW_GUIDANCE_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
  resetWorkflowCache();
  resetPolicyCache();
  fs.rmSync(configRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── Diagnosis: characterize the two read paths AC4.2's branch depends on ────

describe("AC4.2 diagnosis — read-path semantics (regression guards)", () => {
  it("step guidance is read fresh from disk on every wake (NOT cached)", async () => {
    const first = await wakeMessage();
    expect(first).toContain("Always check the diff.");

    // Edit on disk. No cache reset, no restart, no apply pipeline.
    fs.writeFileSync(guidancePath(), NEW_GUIDANCE, "utf8");

    const second = await wakeMessage();
    expect(second).toContain("Always check the diff AND run the tests.");
    expect(second).not.toContain("Always check the diff.\n");
  });

  it("workflow YAML defs ARE cached in-process until resetWorkflowCache()", async () => {
    const before = await loadWorkflowDefById("dev-impl");
    expect(before?.version).toBe(3);

    fs.writeFileSync(
      path.join(configRoot, "workflows", "dev-impl.yaml"),
      WORKFLOW_YAML.replace("version: 3", "version: 4"),
      "utf8",
    );

    // Still the stale cached def — this is why AC4.3 needs a reload endpoint.
    const stale = await loadWorkflowDefById("dev-impl");
    expect(stale?.version).toBe(3);

    resetWorkflowCache();
    const fresh = await loadWorkflowDefById("dev-impl");
    expect(fresh?.version).toBe(4);
  });
});

// ── AC4.2 proper: apply → next wake read serves the new guidance ────────────

describe("AC4.2 — a guidance apply is served on the next wake read, no restart", () => {
  it("serves applied guidance to the very next wake with no cache reset and no restart", async () => {
    const pipeline = new ApplyPipeline({ proposals, observations, configRoot });
    const record = proposals.create(seedProposal());
    proposals.setStatus(record.id, "approved");

    const before = await wakeMessage();
    expect(before).toContain("Always check the diff.");

    const result = await pipeline.apply(record.id);
    expect(result.outcome).toBe("applied");

    // Deliberately NO resetWorkflowCache() and no re-import gymnastics here:
    // the next wake must see the new guidance purely because the read is fresh.
    const after = await wakeMessage();
    expect(after).toContain("Always check the diff AND run the tests.");

    // And the guidance block is still rendered as guidance, not raw-dumped.
    expect(after).toContain("Step guidance");
  });

  it("the applied guidance is what landed on disk, byte for byte", async () => {
    const pipeline = new ApplyPipeline({ proposals, observations, configRoot });
    const record = proposals.create(seedProposal());
    proposals.setStatus(record.id, "approved");

    await pipeline.apply(record.id);

    expect(fs.readFileSync(guidancePath(), "utf8")).toBe(NEW_GUIDANCE);
    expect(proposals.get(record.id)?.status).toBe("applied");
  });

  it("an in-flight wake started before the apply still completes successfully", async () => {
    const pipeline = new ApplyPipeline({ proposals, observations, configRoot });
    const record = proposals.create(seedProposal());
    proposals.setStatus(record.id, "approved");

    // Start a wake build and an apply concurrently. The wake must not throw,
    // and must resolve to one coherent version of the guidance.
    const [msg] = await Promise.all([wakeMessage(), pipeline.apply(record.id)]);

    const sawOld = msg.includes("Always check the diff.");
    const sawNew = msg.includes("Always check the diff AND run the tests.");
    expect(sawOld || sawNew).toBe(true);
  });
});
