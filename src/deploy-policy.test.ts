/**
 * AI-1795 — no-CI-auto-deploy guard tests.
 *
 * Covers the deploy-policy loader (missing/malformed/matching semantics) and
 * the workflow-gate guard: `deploy` is blocked on repos flagged
 * `ci_auto_deploy: false` (resolved via repo:* label OR GitHub PR attachment),
 * `handoff-host-deploy` always passes, unflagged/unresolvable repos are
 * unaffected, and the guard emits a deduped warning alert.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, jest } from "@jest/globals";
import { checkWorkflowRules, resetWorkflowCache, resetNativeStateCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import {
  loadDeployPolicy,
  resetDeployPolicyCache,
  reposWithoutCiAutoDeploy,
  githubRepoFromUrl,
} from "./deploy-policy.js";
import { initAlertBus, _resetAlertBusForTests } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
  - id: deploy:execute

containers:
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, workflow:break-glass]

roles:
  - id: deployment
    requires: [deploy:execute]
  - id: host-deploy
    requires: [linear:transition]
  - id: steward
    requires: [workflow:break-glass]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: grover
    container: steward
    fills_roles: [host-deploy]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: deployment

break_glass:
  command: escape
  to: deployment
  owner_role: steward

states:
  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: doing
    transitions:
      - command: deploy
        to: done
        requires_capability: deploy:execute
      - command: handoff-host-deploy
        to: host-deploy
        assign: { mode: auto }

  - id: host-deploy
    owner_role: host-deploy
    kind: normal
    native_state: doing
    transitions:
      - command: host-deployed
        to: done

  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const DEPLOY_POLICY_YAML = `
repos:
  linear-webhook-fancymatt:
    ci_auto_deploy: false
  fancymatt/owner-qualified-repo:
    ci_auto_deploy: false
  auto-deploying-repo:
    ci_auto_deploy: true
`;

let dir: string;
let alertStore: AlertStore;

function writeDeployPolicy(content: string | null): void {
  const file = path.join(dir, "deploy-policy.yaml");
  if (content === null) {
    fs.rmSync(file, { force: true });
  } else {
    fs.writeFileSync(file, content, "utf8");
  }
  process.env.DEPLOY_POLICY_PATH = file;
  resetDeployPolicyCache();
}

/**
 * Mock fetch: label context, team states, branch/PR done-gate data (merged PR
 * so the done gate always passes), and the AI-1795 attachments query.
 */
function makeGateFetch(labelNames: string[], attachmentUrls: string[]): typeof globalThis.fetch {
  const mockTeamStates = [
    { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
    { id: "state-doing-uuid", name: "Doing", type: "started" },
    { id: "state-done-uuid", name: "Done", type: "completed" },
  ];
  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const respond = (data: unknown) =>
      new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (bodyText.includes("TeamStates")) {
      return respond({ team: { states: { nodes: mockTeamStates } } });
    }
    if (bodyText.includes("IssueRepoAttachments")) {
      return respond({
        issue: { attachments: { nodes: attachmentUrls.map((url) => ({ url, sourceType: "github" })) } },
      });
    }
    if (bodyText.includes("IssueBranchAndPR")) {
      return respond({
        issue: {
          branch: { id: "branch-id", name: "feature", updatedAt: "2026-07-01T00:00:00Z" },
          pullRequests: { nodes: [{ id: "pr-id", state: "merged" }] },
        },
      });
    }
    if (bodyText.includes("delegate")) {
      return respond({ issue: { labels: { nodes: labelNames.map((name) => ({ name })) }, delegate: null } });
    }
    return respond({ issue: { labels: { nodes: labelNames.map((name) => ({ name })) } } });
  };
}

const realFetch = globalThis.fetch;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-policy-test-"));

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const workflowFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = workflowFile;

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        { name: "hanzo", linearUserId: "hanzo-linear-uuid", clientId: "h", clientSecret: "h", accessToken: "h", refreshToken: "h" },
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a", clientSecret: "a", accessToken: "a", refreshToken: "a" },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = agentsFile;
  reloadAgents();
});

beforeEach(() => {
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  resetDeployPolicyCache();
  _resetAlertBusForTests();
  alertStore = new AlertStore(":memory:");
  initAlertBus({ store: alertStore, pushEnabled: false });
  writeDeployPolicy(DEPLOY_POLICY_YAML);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  delete process.env.DEPLOY_POLICY_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Loader / matching unit tests ───────────────────────────────────────────

describe("deploy-policy loader", () => {
  it("missing file → empty policy, nothing flagged", () => {
    writeDeployPolicy(null);
    expect(loadDeployPolicy()).toEqual({ repos: {} });
    expect(reposWithoutCiAutoDeploy(["linear-webhook-fancymatt"])).toEqual([]);
  });

  it("malformed file → empty policy + warning alert (fail-visible)", () => {
    writeDeployPolicy("repos: [not, a, mapping]");
    expect(loadDeployPolicy()).toEqual({ repos: {} });
    const rows = alertStore.query({ source: "deploy-policy" });
    expect(rows.length).toBe(1);
    expect(rows[0].severity).toBe("warning");
    expect(rows[0].title).toContain("failed to load");
  });

  it("flags only ci_auto_deploy: false repos", () => {
    expect(reposWithoutCiAutoDeploy(["auto-deploying-repo"])).toEqual([]);
    expect(reposWithoutCiAutoDeploy(["linear-webhook-fancymatt"])).toEqual(["linear-webhook-fancymatt"]);
  });

  it("bare policy key matches owner-qualified ref, and vice versa; case-insensitive", () => {
    expect(reposWithoutCiAutoDeploy(["fancymatt/linear-webhook-fancymatt"])).toEqual(["linear-webhook-fancymatt"]);
    expect(reposWithoutCiAutoDeploy(["owner-qualified-repo"])).toEqual(["fancymatt/owner-qualified-repo"]);
    expect(reposWithoutCiAutoDeploy(["Fancymatt/Linear-Webhook-Fancymatt"])).toEqual(["linear-webhook-fancymatt"]);
  });

  it("owner-qualified key does not match a different owner", () => {
    expect(reposWithoutCiAutoDeploy(["someone-else/owner-qualified-repo"])).toEqual([]);
  });

  it("picks up policy edits without a restart (mtime cache)", () => {
    expect(reposWithoutCiAutoDeploy(["brand-new-repo"])).toEqual([]);
    // Ensure a distinct mtime even on coarse-grained filesystems.
    const file = path.join(dir, "deploy-policy.yaml");
    fs.writeFileSync(file, "repos:\n  brand-new-repo:\n    ci_auto_deploy: false\n", "utf8");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(reposWithoutCiAutoDeploy(["brand-new-repo"])).toEqual(["brand-new-repo"]);
  });
});

describe("githubRepoFromUrl", () => {
  it("parses PR / branch / commit URLs", () => {
    expect(githubRepoFromUrl("https://github.com/fancymatt/linear-webhook-fancymatt/pull/143")).toBe("fancymatt/linear-webhook-fancymatt");
    expect(githubRepoFromUrl("https://github.com/o/r/tree/feat/branch-name")).toBe("o/r");
    expect(githubRepoFromUrl("https://github.com/o/r.git")).toBe("o/r");
  });

  it("ignores non-GitHub URLs", () => {
    expect(githubRepoFromUrl("https://gitlab.com/o/r/-/merge_requests/1")).toBeNull();
    expect(githubRepoFromUrl("not a url")).toBeNull();
  });
});

// ── Gate integration tests ─────────────────────────────────────────────────

const DEPLOYMENT_LABELS = ["wf:dev-impl", "state:deployment"];

describe("checkWorkflowRules — AI-1795 no-CI-auto-deploy guard", () => {
  it("blocks 'deploy' when a repo:* label names a flagged repo", async () => {
    globalThis.fetch = makeGateFetch([...DEPLOYMENT_LABELS, "repo:linear-webhook-fancymatt"], []);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("no CI auto-deploy");
    expect(result).toContain("handoff-host-deploy");
  });

  it("blocks 'deploy' when a GitHub PR attachment names a flagged repo (AI-1775 scenario: no repo label)", async () => {
    globalThis.fetch = makeGateFetch(DEPLOYMENT_LABELS, [
      "https://github.com/fancymatt/linear-webhook-fancymatt/pull/144",
    ]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("handoff-host-deploy");
  });

  it("allows 'deploy' on an unflagged repo", async () => {
    globalThis.fetch = makeGateFetch(DEPLOYMENT_LABELS, ["https://github.com/fancymatt/auto-deploying-repo/pull/9"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).toBeNull();
  });

  it("allows 'deploy' when no repo is resolvable (guard is opt-in)", async () => {
    globalThis.fetch = makeGateFetch(DEPLOYMENT_LABELS, []);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).toBeNull();
  });

  it("allows 'handoff-host-deploy' on a flagged repo", async () => {
    globalThis.fetch = makeGateFetch([...DEPLOYMENT_LABELS, "repo:linear-webhook-fancymatt"], []);
    const result = await checkWorkflowRules("handoff-host-deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).toBeNull();
  });

  it("emits ONE deduped warning alert naming ticket and repo when the guard fires twice", async () => {
    globalThis.fetch = makeGateFetch([...DEPLOYMENT_LABELS, "repo:linear-webhook-fancymatt"], []);
    await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    const rows = alertStore.query({ source: "deploy-policy" });
    expect(rows.length).toBe(1);
    expect(rows[0].count).toBe(2);
    expect(rows[0].severity).toBe("warning");
    expect(rows[0].ticket).toBe("issue-uuid");
    expect(rows[0].title).toContain("linear-webhook-fancymatt");
  });

  it("attachment fetch failure fails open (deploy allowed)", async () => {
    const base = makeGateFetch(DEPLOYMENT_LABELS, []);
    globalThis.fetch = (async (url: any, init: any) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("IssueRepoAttachments")) throw new Error("ECONNRESET");
      return base(url, init);
    }) as typeof globalThis.fetch;
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).toBeNull();
  });
});
