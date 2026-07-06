/**
 * AI-1872 — dev-impl workflow: split deployment into merge + deploy states;
 * generic verbs only.
 *
 * These tests are FAILING by design. They cover the acceptance criteria that
 * the implementation (Igor) must satisfy:
 *
 * AC-to-test mapping:
 *   AC1: canonical-dev-impl.yaml has `merge` and `deploy` states; version bumped;
 *        `deployment` and `host-deploy` states removed.
 *   AC2: guidance docs `merge.md` and `deploy.md` exist; both document
 *        `continue-workflow` and the "no deploy needed" path.
 *   AC3: custom verbs `deploy`, `handoff-host-deploy`, `host-deployed` absent
 *        from the YAML transitions; generic `continue` edges cover both new states.
 *   AC5: workflow gate rejects commands from `state:deployment` and `state:host-deploy`
 *        because those states no longer exist in the updated def.
 *   AC6: integration — `createApp()` (the production entry point) boots and the
 *        workflow registry is reachable with the updated def. NOT a unit test that
 *        calls `loadWorkflowDef` directly.
 *   AC7: `/health` exposes a `workflowRegistry` entry confirming the updated
 *        dev-impl def is loaded (version ≥ 9, states include `merge` + `deploy`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { createApp } from "./index.js";
import { resetConfigHealth } from "./config-health.js";

// ── Fixture path ──────────────────────────────────────────────────────────────

const CANONICAL_FIXTURE = path.resolve(
  process.cwd(),
  "src/__fixtures__/canonical-dev-impl.yaml",
);

// ── Minimal capability policy (deploy + infra:ssh roles for legacy bodies) ────

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: deploy:execute
  - id: infra:ssh

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: code-review
    grants: [linear:transition]
  - id: test-author
    grants: [linear:transition]
  - id: host-deploy
    grants: [linear:transition, infra:ssh]

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: code-review
    requires: [linear:transition]
  - id: test-author
    requires: [linear:transition]
  - id: host-deploy
    requires: [infra:ssh]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: grover
    container: host-deploy
    fills_roles: [host-deploy]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: testdrivendevelopmentagent
    container: test-author
    fills_roles: [test-author]
`;

// ── Shared test state ─────────────────────────────────────────────────────────

let dir: string;
let savedFetch: typeof globalThis.fetch;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1872-test-"));

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        { name: "hanzo", linearUserId: "hanzo-uuid", clientId: "h-c", clientSecret: "h-s", accessToken: "h-t", refreshToken: "h-r" },
        { name: "grover", linearUserId: "grover-uuid", clientId: "g-c", clientSecret: "g-s", accessToken: "g-t", refreshToken: "g-r" },
        { name: "igor", linearUserId: "igor-uuid", clientId: "i-c", clientSecret: "i-s", accessToken: "i-t", refreshToken: "i-r" },
        { name: "astrid", linearUserId: "astrid-uuid", clientId: "a-c", clientSecret: "a-s", accessToken: "a-t", refreshToken: "a-r" },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = agentsFile;
  reloadAgents();

  process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;

  // AC2: Point guidance dir at the committed templates under config-templates/
  // so tests verify repo-resident files (not instance-level filesystem state).
  process.env.WORKFLOW_GUIDANCE_DIR = path.resolve(
    process.cwd(),
    "config-templates",
    "workflows",
  );

  savedFetch = globalThis.fetch;
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.AGENTS_FILE;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.WORKFLOW_GUIDANCE_DIR;
  globalThis.fetch = savedFetch;
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  resetConfigHealth();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadCanonicalFixture(): Record<string, unknown> {
  const raw = fs.readFileSync(CANONICAL_FIXTURE, "utf8");
  return yaml.load(raw) as Record<string, unknown>;
}

type StateDef = { id: string; kind?: string; transitions?: Array<{ command: string; to: string }> };

function getStates(def: Record<string, unknown>): StateDef[] {
  return (def.states as StateDef[] | undefined) ?? [];
}

function allTransitionCommands(def: Record<string, unknown>): string[] {
  return getStates(def).flatMap((s) => (s.transitions ?? []).map((t) => t.command));
}

function makeLabelFetch(labelNames: string[]): typeof globalThis.fetch {
  return async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("TeamStates")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                  { id: "state-done-uuid", name: "Done", type: "completed" },
                  { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        data: {
          issue: {
            labels: { nodes: labelNames.map((n) => ({ name: n })) },
            delegate: null,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

// ── AC1: canonical fixture has merge + deploy states; version bumped ──────────

describe("AC1: canonical-dev-impl.yaml — merge + deploy states; version bumped", () => {
  it("version is bumped above 8 (v8 was the deployment+host-deploy shape)", () => {
    const def = loadCanonicalFixture();
    expect(def.version).toBeGreaterThan(8);
  });

  it("has a 'merge' state", () => {
    const def = loadCanonicalFixture();
    const ids = getStates(def).map((s) => s.id);
    expect(ids).toContain("merge");
  });

  it("has a 'deploy' state", () => {
    const def = loadCanonicalFixture();
    const ids = getStates(def).map((s) => s.id);
    expect(ids).toContain("deploy");
  });

  it("does NOT have a 'deployment' state (removed by this change)", () => {
    const def = loadCanonicalFixture();
    const ids = getStates(def).map((s) => s.id);
    expect(ids).not.toContain("deployment");
  });

  it("does NOT have a 'host-deploy' state (removed by this change)", () => {
    const def = loadCanonicalFixture();
    const ids = getStates(def).map((s) => s.id);
    expect(ids).not.toContain("host-deploy");
  });

  it("merge state owner_role is 'deployment' (Hanzo is the merger)", () => {
    const def = loadCanonicalFixture();
    const merge = getStates(def).find((s) => s.id === "merge") as (StateDef & { owner_role?: string }) | undefined;
    expect(merge).toBeDefined();
    expect(merge!.owner_role).toBe("deployment");
  });

  it("deploy state has an owner_role set (deployer is configurable)", () => {
    const def = loadCanonicalFixture();
    const deploy = getStates(def).find((s) => s.id === "deploy") as (StateDef & { owner_role?: string }) | undefined;
    expect(deploy).toBeDefined();
    expect(deploy!.owner_role).toBeTruthy();
  });

  it("code-review state transitions lead to 'merge' (not 'deployment')", () => {
    const def = loadCanonicalFixture();
    const cr = getStates(def).find((s) => s.id === "code-review");
    expect(cr).toBeDefined();
    const forwardTargets = (cr!.transitions ?? []).map((t) => t.to);
    expect(forwardTargets).toContain("merge");
    expect(forwardTargets).not.toContain("deployment");
  });
});

// ── AC3: custom verbs removed; generic continue edges cover new states ─────────

describe("AC3: custom verbs absent; generic continue covers merge + deploy", () => {
  it("no transition command named 'deploy' exists anywhere in the YAML", () => {
    const def = loadCanonicalFixture();
    const commands = allTransitionCommands(def);
    expect(commands).not.toContain("deploy");
  });

  it("no transition command named 'handoff-host-deploy' exists anywhere in the YAML", () => {
    const def = loadCanonicalFixture();
    const commands = allTransitionCommands(def);
    expect(commands).not.toContain("handoff-host-deploy");
  });

  it("no transition command named 'host-deployed' exists anywhere in the YAML", () => {
    const def = loadCanonicalFixture();
    const commands = allTransitionCommands(def);
    expect(commands).not.toContain("host-deployed");
  });

  it("merge state has a 'continue' command transition (generic forward)", () => {
    const def = loadCanonicalFixture();
    const merge = getStates(def).find((s) => s.id === "merge");
    expect(merge).toBeDefined();
    const commands = (merge!.transitions ?? []).map((t) => t.command);
    expect(commands).toContain("continue");
  });

  it("deploy state has a 'continue' command transition (generic forward)", () => {
    const def = loadCanonicalFixture();
    const deploy = getStates(def).find((s) => s.id === "deploy");
    expect(deploy).toBeDefined();
    const commands = (deploy!.transitions ?? []).map((t) => t.command);
    expect(commands).toContain("continue");
  });

  it("merge state 'continue' leads to 'deploy'", () => {
    const def = loadCanonicalFixture();
    const merge = getStates(def).find((s) => s.id === "merge");
    const cont = (merge?.transitions ?? []).find((t) => t.command === "continue");
    expect(cont).toBeDefined();
    expect(cont!.to).toBe("deploy");
  });

  it("deploy state 'continue' leads to 'ac-validate'", () => {
    const def = loadCanonicalFixture();
    const deploy = getStates(def).find((s) => s.id === "deploy");
    const cont = (deploy?.transitions ?? []).find((t) => t.command === "continue");
    expect(cont).toBeDefined();
    expect(cont!.to).toBe("ac-validate");
  });
});

// ── AC2: guidance docs merge.md and deploy.md ────────────────────────────────

describe("AC2: guidance docs merge.md and deploy.md written", () => {
  function guidanceDir(): string {
    return process.env.WORKFLOW_GUIDANCE_DIR ?? path.join(
      process.env.LINEAR_CONNECTOR_CONFIG_DIR ?? path.join(os.homedir(), ".openclaw", "linear-connector"),
      "workflows",
    );
  }

  it("merge.md exists in the dev-impl guidance directory", () => {
    const filePath = path.join(guidanceDir(), "dev-impl", "merge.md");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("deploy.md exists in the dev-impl guidance directory", () => {
    const filePath = path.join(guidanceDir(), "dev-impl", "deploy.md");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("merge.md contains 'continue-workflow' (agents know how to advance)", () => {
    const filePath = path.join(guidanceDir(), "dev-impl", "merge.md");
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("continue-workflow");
  });

  it("deploy.md contains 'continue-workflow'", () => {
    const filePath = path.join(guidanceDir(), "dev-impl", "deploy.md");
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("continue-workflow");
  });

  it("deploy.md documents the 'no deploy needed' path explicitly", () => {
    const filePath = path.join(guidanceDir(), "dev-impl", "deploy.md");
    const content = fs.readFileSync(filePath, "utf8").toLowerCase();
    expect(content).toMatch(/no deploy needed|no deployment needed|skip.*deploy|deploy.*not.*required/);
  });

  it("merge.md documents what 'continue-workflow' means at the merge step", () => {
    const filePath = path.join(guidanceDir(), "dev-impl", "merge.md");
    const content = fs.readFileSync(filePath, "utf8").toLowerCase();
    // Must contain substantive merge-step context — not just a verb mention.
    expect(content).toMatch(/merge|pull request|pr/);
  });
});

// ── AC5: state:deployment and state:host-deploy are not valid workflow states ─

describe("AC5: state:deployment + state:host-deploy no longer exist; gate rejects them", () => {
  it("checkWorkflowRules returns a rejection for any command from state:deployment", async () => {
    // After the split, 'deployment' is not a valid state. The gate must not
    // allow any command from a ticket stuck at this defunct label.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    const result = await checkWorkflowRules("continue-workflow", "issue-uuid", "Bearer tok", "hanzo");
    // Must not be null (null = allowed / pass-through). Must surface an error.
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
  });

  it("checkWorkflowRules returns a rejection for any command from state:host-deploy", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:host-deploy"]);
    const result = await checkWorkflowRules("continue-workflow", "issue-uuid", "Bearer tok", "grover");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
  });

  it("checkWorkflowRules allows continue-workflow from state:merge for hanzo", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"]);
    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).toBeNull();
  });

  it("checkWorkflowRules allows continue-workflow from state:deploy for the deployer", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deploy"]);
    // grover is the default deployer for the connector fleet
    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "grover");
    expect(result).toBeNull();
  });
});

// ── AC6 + AC7: integration — createApp boots; /health exposes workflow registry ─

describe("AC6+AC7: integration — createApp boots entry point; /health shows updated registry", () => {
  let app: ReturnType<typeof createApp>["app"];

  beforeAll(async () => {
    // Point to a test workflow def that has the updated shape (merge + deploy states).
    // In production this is the real dev-impl.yaml; in tests we use the canonical fixture
    // which the implementer must update.
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
    process.env.LINEAR_CONNECTOR_SECRET = "test-secret-ai1872";
    process.env.LINEAR_WEBHOOK_SECRET = "test-webhook-ai1872";

    const appResult = createApp({
      bagDbPath: path.join(dir, "bag-ai1872.db"),
      agentQueueDbPath: path.join(dir, "queue-ai1872.db"),
      operationalEventsDbPath: path.join(dir, "ops-ai1872.db"),
      observationsDbPath: path.join(dir, "obs-ai1872.db"),
      managingStateDbPath: path.join(dir, "managing-ai1872.db"),
    });
    app = appResult.app;
  });

  afterAll(() => {
    delete process.env.LINEAR_CONNECTOR_SECRET;
    delete process.env.LINEAR_WEBHOOK_SECRET;
  });

  it("createApp() returns without throwing (entry point boots)", () => {
    expect(app).toBeDefined();
  });

  it("/health responds 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("/health exposes a 'workflowRegistry' field (AC7: liveness observable)", async () => {
    // The implementation must add workflowRegistry to the /health response so
    // ac-validate can confirm the updated def is loaded. Fails until implemented.
    const res = await request(app).get("/health");
    expect(res.body).toHaveProperty("workflowRegistry");
  });

  it("/health workflowRegistry includes dev-impl entry", async () => {
    const res = await request(app).get("/health");
    const registry = res.body.workflowRegistry as Record<string, unknown> | undefined;
    expect(registry).toBeDefined();
    expect(registry!["dev-impl"]).toBeDefined();
  });

  it("/health workflowRegistry dev-impl entry has version > 8", async () => {
    const res = await request(app).get("/health");
    const registry = res.body.workflowRegistry as Record<string, unknown> | undefined;
    const entry = registry?.["dev-impl"] as { version?: number } | undefined;
    expect(entry?.version).toBeGreaterThan(8);
  });

  it("/health workflowRegistry dev-impl entry includes 'merge' in states", async () => {
    const res = await request(app).get("/health");
    const registry = res.body.workflowRegistry as Record<string, unknown> | undefined;
    const entry = registry?.["dev-impl"] as { states?: string[] } | undefined;
    expect(entry?.states).toContain("merge");
  });

  it("/health workflowRegistry dev-impl entry includes 'deploy' in states", async () => {
    const res = await request(app).get("/health");
    const registry = res.body.workflowRegistry as Record<string, unknown> | undefined;
    const entry = registry?.["dev-impl"] as { states?: string[] } | undefined;
    expect(entry?.states).toContain("deploy");
  });

  it("/health workflowRegistry dev-impl entry does NOT include 'deployment' in states", async () => {
    const res = await request(app).get("/health");
    const registry = res.body.workflowRegistry as Record<string, unknown> | undefined;
    const entry = registry?.["dev-impl"] as { states?: string[] } | undefined;
    expect(entry?.states).not.toContain("deployment");
  });

  it("/health workflowRegistry dev-impl entry does NOT include 'host-deploy' in states", async () => {
    const res = await request(app).get("/health");
    const registry = res.body.workflowRegistry as Record<string, unknown> | undefined;
    const entry = registry?.["dev-impl"] as { states?: string[] } | undefined;
    expect(entry?.states).not.toContain("host-deploy");
  });
});
