/**
 * INF-62 — dev-impl no-CI-auto-deploy guard must survive the v10 generic
 * merge/deploy split.
 *
 * AC mapping:
 *   AC1: flagged repo + direct merge -> ac-validate fixture is blocked and
 *        routes through the host-deploy-owned deploy state.
 *   AC2: the same guard fires when the only repo evidence is a GitHub PR
 *        attachment for fancymatt/gen.
 *   AC3: flagged repo + proper merge -> deploy -> ac-validate path is allowed;
 *        unflagged repo direct edge remains unchanged.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "@jest/globals";
import { checkWorkflowRules, resetNativeStateCache, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetDeployPolicyCache } from "./deploy-policy.js";
import { reloadAgents } from "./agents.js";

const CAPABILITY_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
  - id: deploy:execute
  - id: infra:ssh

containers:
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: host-deploy
    grants: [linear:transition, infra:ssh]
  - id: steward
    grants: [linear:transition, workflow:break-glass]

roles:
  - id: deployment
    requires: [deploy:execute]
  - id: host-deploy
    requires: [infra:ssh]
  - id: steward
    requires: [workflow:break-glass]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: grover
    container: host-deploy
    fills_roles: [host-deploy]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

const SKIP_DEPLOY_WORKFLOW_YAML = `
id: dev-impl
version: 62
archetype: single-task
entry_state: merge

break_glass:
  command: escape
  to: merge
  owner_role: steward

states:
  - id: merge
    owner_role: deployment
    kind: normal
    native_state: todo
    transitions:
      - command: continue
        to: ac-validate
        generic: continue
        requires_capability: deploy:execute
        assign: { mode: auto }

  - id: deploy
    owner_role: host-deploy
    kind: normal
    native_state: todo
    transitions:
      - command: continue
        to: ac-validate
        generic: continue
        requires_capability: infra:ssh
        assign: { mode: auto }

  - id: ac-validate
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: validated
        to: done

  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const PROPER_DEPLOY_WORKFLOW_YAML = SKIP_DEPLOY_WORKFLOW_YAML.replace(
  "to: ac-validate\n        generic: continue\n        requires_capability: deploy:execute",
  "to: deploy\n        generic: continue\n        requires_capability: deploy:execute",
);

const DEPLOY_POLICY_YAML = `
repos:
  fancymatt/gen:
    ci_auto_deploy: false
  fancymatt/auto-deploying-repo:
    ci_auto_deploy: true
`;

let dir: string;
const realFetch = globalThis.fetch;

function writeWorkflow(name: string, content: string): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf8");
  process.env.WORKFLOW_DEF_PATH = file;
  resetWorkflowCache();
  resetNativeStateCache();
}

function makeGateFetch(labelNames: string[], attachmentUrls: string[]): typeof globalThis.fetch {
  const mockTeamStates = [
    { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
    { id: "state-done-uuid", name: "Done", type: "completed" },
  ];
  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const respond = (data: unknown) =>
      new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });

    if (bodyText.includes("TeamStates")) {
      return respond({ team: { states: { nodes: mockTeamStates } } });
    }

    if (bodyText.includes("IssueBranchAndPR")) {
      return respond({
        issue: {
          attachments: {
            nodes: [{ url: "https://github.com/fancymatt/gen/pull/198", sourceType: "github", metadata: { status: "merged" } }],
          },
        },
      });
    }

    if (bodyText.includes("IssueRepoAttachments")) {
      return respond({
        issue: { attachments: { nodes: attachmentUrls.map((url) => ({ url, sourceType: "github" })) } },
      });
    }

    if (bodyText.includes("delegate")) {
      return respond({ issue: { labels: { nodes: labelNames.map((name) => ({ name })) }, delegate: null } });
    }

    return respond({ issue: { labels: { nodes: labelNames.map((name) => ({ name })) } } });
  };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-62-deploy-policy-"));

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, CAPABILITY_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        { name: "hanzo", linearUserId: "hanzo-linear-uuid", clientId: "h", clientSecret: "h", accessToken: "h", refreshToken: "h" },
        { name: "grover", linearUserId: "grover-linear-uuid", clientId: "g", clientSecret: "g", accessToken: "g", refreshToken: "g" },
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a", clientSecret: "a", accessToken: "a", refreshToken: "a" },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = agentsFile;
  reloadAgents();

  const deployPolicyFile = path.join(dir, "deploy-policy.yaml");
  fs.writeFileSync(deployPolicyFile, DEPLOY_POLICY_YAML, "utf8");
  process.env.DEPLOY_POLICY_PATH = deployPolicyFile;
});

beforeEach(() => {
  resetPolicyCache();
  resetDeployPolicyCache();
  resetNativeStateCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.DEPLOY_POLICY_PATH;
  delete process.env.AGENTS_FILE;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("INF-62 deploy-policy guard on dev-impl v10 generic continue", () => {
  it("AC1/AC3 blocks a flagged gen-labeled direct merge -> ac-validate attempt and routes to host-deploy", async () => {
    writeWorkflow("skip-deploy.yaml", SKIP_DEPLOY_WORKFLOW_YAML);
    globalThis.fetch = makeGateFetch(["wf:dev-impl", "state:merge", "repo:gen", "stakes:low"], []);

    const result = await checkWorkflowRules("continue", "GEN-SKIP", "Bearer tok", "hanzo");

    expect(result).not.toBeNull();
    expect(result).toContain("no CI auto-deploy");
    expect(result).toContain("host-deploy");
    expect(result).toContain("deploy");
  });

  it("AC2 blocks the same skip when fancymatt/gen is known only from a GitHub PR attachment", async () => {
    writeWorkflow("skip-deploy.yaml", SKIP_DEPLOY_WORKFLOW_YAML);
    globalThis.fetch = makeGateFetch(["wf:dev-impl", "state:merge", "stakes:low"], [
      "https://github.com/fancymatt/gen/pull/198",
    ]);

    const result = await checkWorkflowRules("continue", "GEN-SKIP-PR", "Bearer tok", "hanzo");

    expect(result).not.toBeNull();
    expect(result).toContain("fancymatt/gen");
    expect(result).toContain("host-deploy");
  });

  it("AC3 allows a flagged repo to traverse the proper merge -> deploy edge", async () => {
    writeWorkflow("proper-deploy.yaml", PROPER_DEPLOY_WORKFLOW_YAML);
    globalThis.fetch = makeGateFetch(["wf:dev-impl", "state:merge", "repo:gen", "stakes:low"], []);

    await expect(checkWorkflowRules("continue", "GEN-MERGE", "Bearer tok", "hanzo")).resolves.toBeNull();
  });

  it("AC3 allows a flagged repo to leave deploy after the host-deploy owner confirms deploy", async () => {
    writeWorkflow("proper-deploy.yaml", PROPER_DEPLOY_WORKFLOW_YAML);
    globalThis.fetch = makeGateFetch(["wf:dev-impl", "state:deploy", "repo:gen", "stakes:low"], []);

    await expect(checkWorkflowRules("continue", "GEN-DEPLOYED", "Bearer tok", "grover")).resolves.toBeNull();
  });

  it("AC3 leaves unflagged repos unchanged even on the direct merge -> ac-validate fixture", async () => {
    writeWorkflow("skip-deploy.yaml", SKIP_DEPLOY_WORKFLOW_YAML);
    globalThis.fetch = makeGateFetch(["wf:dev-impl", "state:merge", "repo:auto-deploying-repo", "stakes:low"], []);

    await expect(checkWorkflowRules("continue", "AUTO-DEPLOY", "Bearer tok", "hanzo")).resolves.toBeNull();
  });
});
