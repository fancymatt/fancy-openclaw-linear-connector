import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { checkWorkflowRules, resetWorkflowCache, loadWorkflowDefById } from "../workflow-gate.js";
import { executeFanout } from "../fanout.js";
import { resetPolicyCache } from "../escalation-gate.js";

// Minimal policy for E2E tests
const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
  - id: sprint:signoff

containers:
  - id: workflow
    grants: [linear:transition, workflow:break-glass]
  - id: ai
    grants: [linear:transition, sprint:signoff]

roles:
  - id: steward
    requires: [workflow:break-glass]

bodies:
  - id: astrid
    container: workflow
    fills_roles: [steward]
  - id: ai
    container: ai
    fills_roles: []
`;

const ASTRID_UUID = "astrid-linear-uuid";

describe("INF-474: Sprint-Workflow E2E Harness", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;
  let originalWorkflowDefsDir: string | undefined;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalWorkflowDefsDir = process.env.WORKFLOW_DEFS_DIR;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-474-e2e-"));
    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    
    // Set up workflow defs directory
    const defsDir = path.join(tmpDir, "defs");
    fs.mkdirSync(defsDir);
    process.env.WORKFLOW_DEFS_DIR = defsDir;
    
    // Copy real defs to tmp for testing
    const realDefsDir = path.join(process.cwd(), "src/registered-defs");
    for (const file of ["sprint-spawner.yaml", "dev-sprint.yaml", "sprint-scoping.yaml", "task.yaml", "dev-impl.yaml"]) {
       fs.copyFileSync(path.join(realDefsDir, file), path.join(defsDir, file));
    }

    resetPolicyCache();
    resetWorkflowCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    process.env.WORKFLOW_DEF_PATH = originalWorkflowPath || "";
    process.env.CAPABILITY_POLICY_PATH = originalPolicyPath || "";
    process.env.WORKFLOW_DEFS_DIR = originalWorkflowDefsDir || "";
  });

  function mockLinearFetch(responses: Record<string, any>) {
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const body = JSON.parse(init?.body as string);
        const query = body.query;
        for (const [key, resp] of Object.entries(responses)) {
          if (query.includes(key)) {
            return new Response(JSON.stringify(resp), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
      }
      return originalFetch(url, init);
    }) as typeof globalThis.fetch;
  }

  it("Phase A: Scoping & Sign-off - validates sprint-spawner transitions", async () => {
    // 1. Trigger: proceed from evaluating -> scanning
    mockLinearFetch({
      "IssueContext": {
        data: {
          issue: {
            identifier: "TEST-1",
            labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:evaluating" }, { name: "harness-green" }] },
            delegate: { id: ASTRID_UUID }
          }
        }
      }
    });

    const result = await checkWorkflowRules("proceed", "issue-uuid", "Bearer tok", "astrid", null, ASTRID_UUID);
    expect(result).toBeNull(); // No error = legal
  });

  it("Phase B: Arm Fan-out - validates dev-sprint spawn-arms", async () => {
     mockLinearFetch({
      "IssueContext": {
        data: {
          issue: {
            identifier: "TEST-2",
            labels: { nodes: [{ name: "wf:dev-sprint" }, { name: "state:spawn-arms" }] },
            delegate: { id: ASTRID_UUID }
          }
        }
      }
    });

    const result = await checkWorkflowRules("spawn", "issue-uuid", "Bearer tok", "astrid", null, ASTRID_UUID);
    expect(result).toBeNull();
  });

  it("Phase D: Ready-to-Spawn Gate - blocks spawner until harness green", async () => {
    mockLinearFetch({
      "IssueContext": {
        data: {
          issue: {
            identifier: "TEST-SPAWNER",
            labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:evaluating" }] },
            delegate: { id: ASTRID_UUID }
          }
        }
      }
    });

    // Attempt to proceed without harness-green label
    const result = await checkWorkflowRules("proceed", "issue-uuid", "Bearer tok", "astrid", null, ASTRID_UUID);
    expect(result).not.toBeNull();
    expect(result).toContain("frozen until the integration-test harness is green");

    // Success with label
    mockLinearFetch({
      "IssueContext": {
        data: {
          issue: {
            identifier: "TEST-SPAWNER",
            labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:evaluating" }, { name: "harness-green" }] },
            delegate: { id: ASTRID_UUID }
          }
        }
      }
    });
    const result2 = await checkWorkflowRules("proceed", "issue-uuid", "Bearer tok", "astrid", null, ASTRID_UUID);
    expect(result2).toBeNull();
  });

  it("Phase E: Fail-Loud - refuses fan-out on empty spec (INF-32/LIF-196 class)", async () => {
    mockLinearFetch({
      "IssueTeamParent": {
        data: {
          issue: {
            id: "issue-internal-id",
            title: "Parent Title",
            description: "No findings here",
            team: { id: "team-id" },
            parent: null
          }
        }
      },
      "commentCreate": {
         data: { commentCreate: { success: true, comment: { id: "comment-id" } } }
      }
    });

    // Test that executeFanout returns a refusal result when findings are empty
    // This is the core logic that prevents silent fall-through
    const result = await executeFanout(
      "issue-uuid",
      "Bearer tok",
      { spec_source: "findings", child_workflow: "wf:dev-impl" },
      { findingsOverride: [], skipPreview: true }
    );
    
    expect(result.refused).toBe(true);
    expect(result.errors[0].message).toContain("No 'findings' entries found");
  });
});
