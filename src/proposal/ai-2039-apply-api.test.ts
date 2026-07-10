/**
 * AI-2039 (P4-C4) — AC4.3 (YAML reload, real cache) + AC4.8 (apply-failed/retry API surface).
 *
 * FAILING tests (write-tests state).
 *
 * AC4.3: a workflow-YAML apply goes through an explicit def reload — the served
 *   def changes WITHOUT a process restart, and a wake already holding a def
 *   reference (in-flight) is unaffected. This drives the REAL workflow-def cache
 *   (`loadWorkflowRegistry` / `resetWorkflowCache`), not a mock, with
 *   `reloadWorkflowDefs = resetWorkflowCache` injected into the pipeline.
 *
 * AC4.8: the retry affordance is "in the API". The merged C5 review-queue console
 *   (AI-2040, PR #203) already posts to `POST /admin/api/proposals/:id/retry-apply`
 *   and lists `GET /admin/api/proposals` with an `apply-failed` status. These tests
 *   pin that HTTP contract so a failed apply is actually retryable from the console.
 *   (End-to-end apply-failed→retry through a seeded proposal is covered at the
 *   pipeline level in ai-2039-apply-pipeline.test.ts; here we assert the routes
 *   the operator's retry button depends on are mounted, not 404.)
 */

import request from "supertest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp } from "../index.js";
import { reloadAgents } from "../agents.js";
import { loadWorkflowDefById, loadWorkflowRegistry, resetWorkflowCache } from "../workflow-gate.js";

type ApplyModule = typeof import("./apply-pipeline.js");
async function loadApply(): Promise<ApplyModule> {
  return (await import("./apply-pipeline.js")) as ApplyModule;
}

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function defYaml(version: number): string {
  return `id: dev-impl
version: ${version}
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
      - command: submit
        to: done
  - id: done
    kind: terminal
    native_state: done
  - id: escape
    kind: terminal
    native_state: invalid
`;
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root });
}

// ── AC4.3 — real def-cache reload on a YAML apply ──────────────────────────

describe("AC4.3 — a YAML apply reloads the served def without restart; in-flight wakes unaffected", () => {
  let root: string;
  let yamlRel: string;
  let yamlPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ai2039-reload-"));
    yamlRel = path.join("workflows", "dev-impl.yaml");
    yamlPath = path.join(root, yamlRel);
    fs.mkdirSync(path.dirname(yamlPath), { recursive: true });
    fs.writeFileSync(yamlPath, defYaml(3), "utf8");
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "tdd@fancymatt.local"]);
    git(root, ["config", "user.name", "tdd"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "seed"]);

    resetWorkflowCache();
    process.env.LINEAR_CONNECTOR_CONFIG_DIR = root;
    process.env.WORKFLOW_DEF_PATH = yamlPath;
  });

  afterEach(() => {
    delete process.env.LINEAR_CONNECTOR_CONFIG_DIR;
    delete process.env.WORKFLOW_DEF_PATH;
    resetWorkflowCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("serves version 4 after the apply (no restart) while the pre-apply def reference stays at 3", async () => {
    const { applyProposal } = await loadApply();

    // Warm the registry cache — this is the "in-flight wake" that already resolved its def.
    await loadWorkflowRegistry();
    const inFlightDef = await loadWorkflowDefById("dev-impl");
    expect(inFlightDef?.version).toBe(3);

    const snapshot = fs.readFileSync(yamlPath, "utf8");
    // The version field is pipeline-managed (AC4.6): newContent carries the semantic
    // change only and keeps version at 3; the apply increments it to 4. A proposal
    // must NOT pre-bake the version bump, or apply would double-count it.
    const newContent = defYaml(3) + "# AI-2039 semantic change to the def\n";
    const targets = [
      { kind: "yaml" as const, path: yamlRel, oldContent: { hash: sha256hex(snapshot), snapshot }, newContent, diff: `bump ${yamlRel}` },
    ];
    const proposal = { id: "yaml-reload", idempotencyKey: sha256hex(sha256hex(yamlRel) + sha256hex(`bump ${yamlRel}`)), targets };

    const store = new Map<string, unknown>();
    const res = await applyProposal(proposal, {
      configRoot: root,
      store: { getByIdempotencyKey: (k: string) => store.get(k) ?? null, record: (r: { idempotencyKey: string }) => store.set(r.idempotencyKey, r) },
      captureMetrics: () => ({ snapshot: {}, window: { since: "a", until: "b" } }),
      reloadWorkflowDefs: resetWorkflowCache, // the REAL reload — no process restart
      now: () => 1_752_100_000_000,
    });
    expect(res.status).toBe("applied");

    // A fresh lookup (a NEW wake) now gets version 4 — served without a restart.
    const reloaded = await loadWorkflowDefById("dev-impl");
    expect(reloaded?.version).toBe(4);

    // The in-flight reference captured before the reload is unchanged.
    expect(inFlightDef?.version).toBe(3);
  });
});

// ── AC4.8 — API surface the merged C5 console depends on ────────────────────

describe("AC4.8 — apply-failed retry affordance is exposed in the API", () => {
  const ADMIN_SECRET = "ai2039-admin-secret";
  let dir: string;
  let appState: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2039-api-"));
    const webDist = path.join(dir, "web-dist");
    fs.mkdirSync(webDist, { recursive: true });
    fs.writeFileSync(path.join(webDist, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [] }), "utf8");

    process.env.AGENTS_FILE = agentsFile;
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.ADMIN_WEB_DIST = webDist;
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "opevents.db"),
      observationsDbPath: path.join(dir, "obs.db"),
    });
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.ADMIN_SECRET;
    delete process.env.ADMIN_WEB_DIST;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("GET /admin/api/proposals returns a proposals list (the console queue source)", async () => {
    const res = await request(appState.app).get("/admin/api/proposals").set("x-admin-secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.proposals)).toBe(true);
  });

  it("POST /admin/api/proposals/:id/retry-apply is mounted (retry button is not a dead 404)", async () => {
    const res = await request(appState.app)
      .post("/admin/api/proposals/some-id/retry-apply")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({});
    // The route must exist. An unmounted route yields Express's DEFAULT 404
    // ("Cannot POST ...", content-type text/html). A mounted handler responds
    // with JSON (even for an unknown proposal id: 404/409/200 + a JSON body).
    // So a JSON response proves the route is wired; a text/html 404 proves it is not.
    const contentType = res.headers["content-type"] ?? "";
    const isDefaultUnmounted404 = res.status === 404 && !contentType.includes("application/json");
    expect(isDefaultUnmounted404).toBe(false);
  });
});
