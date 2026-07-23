/**
 * INF-296 regression: designated_approver capability-gate error message
 * incorrectly suggests `handoff-work` as the remedy.
 *
 * `handoff-work` is a meta-command that is not necessarily a legal transition
 * in the ticket's current state (e.g. sprint-spawner's `determining-scope`
 * has no `handoff-work` transition in its def), so following the suggestion
 * can dead-end the caller. The fix: when a transition is marked
 * `designated_approver: true` and the caller lacks the named capability, the
 * message must instead tell the caller that the designated approver runs the
 * command directly — not route through handoff-work.
 *
 * Scenario: astrid is the ticket delegate at sprint-spawner's
 * determining-scope state and attempts `approve`, a transition marked
 * `designated_approver: true` / `requires_capability: sprint:signoff`. She
 * passes the delegate gate (she IS the delegate) but does not hold
 * sprint:signoff, so the capability gate fires and must emit the
 * designated-approver-specific message under test.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";

const SPAWNER_TEST_YAML = `
id: sprint-spawner
version: 2
archetype: product-loop
entry_state: evaluate

break_glass:
  command: escape
  to: evaluate
  owner_role: steward

states:
  - id: evaluate
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: proceed
        to: determining-scope

  - id: determining-scope
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: propose-brief
        to: launching
        requires_capability: sprint:signoff
        designated_approver: true
      - command: approve
        to: launching
        requires_capability: sprint:signoff
        designated_approver: true
      - command: rescope
        to: evaluate

  - id: launching
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: launch
        to: done

  - id: done
    kind: terminal
    native_state: done
`;

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

// Ticket at determining-scope, delegated to astrid — she IS the delegate but
// lacks the sprint:signoff capability the 'approve' transition requires.
const SPAWNER_AT_SCOPE = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:determining-scope" }] },
      delegate: { id: ASTRID_UUID },
    },
  },
};

describe("INF-296: designated_approver capability-gate message must not suggest handoff-work", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-296-test-"));
    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    const workflowFile = path.join(tmpDir, "sprint-spawner.yaml");
    fs.writeFileSync(workflowFile, SPAWNER_TEST_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    resetPolicyCache();
    resetWorkflowCache();
    originalFetch = globalThis.fetch;
    globalThis.fetch = makeLabelFetch(SPAWNER_AT_SCOPE);
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

  function makeLabelFetch(labelResponse: object) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (url: any, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("IssueLabels")) {
          return new Response(JSON.stringify(labelResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return originalFetch(url, init);
    };
  }

  it("AC1: does NOT suggest `handoff-work` when a designated_approver transition's capability gate fires", async () => {
    // astrid is the delegate (passes the delegate gate) but does not hold
    // sprint:signoff, so the capability gate must fire on 'approve'.
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "astrid", null, ASTRID_UUID);
    expect(result).not.toBeNull();
    expect(result).not.toContain("handoff-work");
  });

  it("AC2: instead names the designated approver and tells them to run the command directly", async () => {
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "astrid", null, ASTRID_UUID);
    expect(result).not.toBeNull();
    // Names the approver (ai holds sprint:signoff in the test policy).
    expect(result).toContain("ai");
    // Tells the approver to run the command directly rather than routing
    // through a handoff.
    expect(result).toMatch(/directly/i);
    expect(result).toContain("approve");
  });
});
