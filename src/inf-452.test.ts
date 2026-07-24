/**
 * INF-452: Automated deploy-outcome gate.
 *
 * Verifies that a transition marked with requires_deploy_probe: true
 * performs the automated live-service probe before advancing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import { applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { clearArtifactStore } from "./artifact-store.js";

const DEPLOY_TEST_YAML = `
id: dev-impl
version: 14
archetype: dev-impl
entry_state: implementation

states:
  - id: implementation
    native_state: todo
    transitions:
      - command: continue
        to: merge

  - id: merge
    native_state: thinking
    transitions:
      - command: continue
        to: deploy

  - id: deploy
    native_state: thinking
    transitions:
      - command: continue
        to: ac-validate
        requires_deploy_probe: true

  - id: ac-validate
    native_state: thinking
    transitions:
      - command: approve
        to: done

  - id: done
    kind: terminal
    native_state: done
`;

describe("INF-452: Automated deploy-outcome gate", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-452-test-"));
    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, "capabilities: []\ncontainers: []\nroles: []\nbodies: []", "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    const workflowFile = path.join(tmpDir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, DEPLOY_TEST_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    resetPolicyCache();
    resetWorkflowCache();
    clearArtifactStore();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
  });

  function mockLinearResponses(issue: any) {
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueWithLabels") || bodyText.includes("IssueLabels") || bodyText.includes("IssueContext") || bodyText.includes("IssueBranchAndPR")) {
          return new Response(JSON.stringify({ data: { issue: { ...issue, attachments: { nodes: [{ url: "https://github.com/org/repo/pull/1", metadata: { status: "merged" } }] } } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (bodyText.includes("TeamLabels")) {
            return new Response(JSON.stringify({ data: { team: { labels: { nodes: [] } } } }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        if (bodyText.includes("WorkflowStates")) {
            return new Response(JSON.stringify({ data: { team: { states: { nodes: [
                { id: "todo-id", name: "To Do" },
                { id: "thinking-id", name: "Thinking" },
                { id: "doing-id", name: "Doing" }
            ] } } } }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        if (bodyText.includes("issueLabelCreate") || bodyText.includes("issueUpdate") || bodyText.includes("commentCreate")) {
            return new Response(JSON.stringify({ data: { [bodyText.includes("issueLabelCreate") ? "issueLabelCreate" : (bodyText.includes("issueUpdate") ? "issueUpdate" : "commentCreate")]: { success: true, issueLabel: { id: "new-label-id" }, comment: { id: "new-comment-id" } } } }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
      }
      // Probe mock
      if (typeof url === "string" && url.includes("api.fancymatt.com/health")) {
          if (url.includes("fail")) {
              return new Response(JSON.stringify({ commit: "old-sha" }), { status: 200 });
          }
          return new Response(JSON.stringify({ commit: "new-sha" }), { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof globalThis.fetch;
  }

  it("AC1: blocks deploy advancement when the live-service probe fails (mismatch)", async () => {
    const issue = {
      id: "issue-uuid",
      identifier: "INF-452",
      team: { id: "team-uuid" },
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deploy" }] },
      delegate: { id: "igor-uuid" }
    };
    mockLinearResponses(issue);

    const result = await applyStateTransition("continue", "INF-452", "Bearer tok", {
      bodyId: "igor",
      deployProbeUrl: "https://api.fancymatt.com/health?fail=1",
      expectedArtifactSymbol: "new-sha"
    });

    expect(result.status).toBe("blocked");
    expect(result.code).toBe("deploy-probe-failed");
    expect(result.detail).toContain("mismatch");
  });

  it("AC1: allows deploy advancement when the live-service probe passes", async () => {
    const issue = {
        id: "issue-uuid",
        identifier: "INF-452",
        team: { id: "team-uuid" },
        labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deploy" }] },
        delegate: { id: "igor-uuid" }
    };
    mockLinearResponses(issue);

    const result = await applyStateTransition("continue", "INF-452", "Bearer tok", {
      bodyId: "igor",
      deployProbeUrl: "https://api.fancymatt.com/health",
      expectedArtifactSymbol: "new-sha"
    });

    expect(result.status).toBe("applied");
    expect(result.to).toBe("ac-validate");
  });

  it("AC1: refuses transition when probe config is missing", async () => {
    const issue = {
        id: "issue-uuid",
        identifier: "INF-452",
        team: { id: "team-uuid" },
        labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deploy" }] },
        delegate: { id: "igor-uuid" }
    };
    mockLinearResponses(issue);

    const result = await applyStateTransition("continue", "INF-452", "Bearer tok", {
      bodyId: "igor"
      // deployProbeUrl and expectedArtifactSymbol missing
    });

    expect(result.status).toBe("failed");
    expect(result.code).toBe("deploy-probe-config-missing");
  });
});
