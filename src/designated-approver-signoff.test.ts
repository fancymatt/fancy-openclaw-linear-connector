/**
 * Designated-approver delegate bypass (Matt directive 2026-07-12, via Astrid).
 *
 * A workflow def can name a `requires_capability` on a transition. A known
 * caller holding that capability may fire THAT transition without being the
 * ticket's current delegate — this is how a def nominates a sign-off authority
 * for a ticket delegated to the work's author (e.g. Ai holding sprint:signoff
 * on sprint-spawner's determining-scope → launching), replacing the
 * requires_human_signoff_above_stakes gate for sprint briefs.
 *
 * Invariants proven here:
 *   1. The nominated approver (ai) can fire the capability-named transition
 *      while NOT the delegate.
 *   2. The bypass is scoped to the matched transition — the same caller is
 *      still delegate-blocked on a sibling transition without the capability.
 *   3. The delegate/author (astrid) cannot self-approve: she passes the
 *      delegate gate trivially but the requires_capability gate blocks her —
 *      author-cannot-self-bless survives the flag removal.
 *   4. A random known agent (charles) without the capability stays
 *      delegate-blocked on the sign-off transition.
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
      - command: bare-capability
        to: launching
        requires_capability: sprint:signoff

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
  - id: dev
    grants: [linear:transition]

roles:
  - id: steward
    requires: [workflow:break-glass]
  - id: dev
    requires: [linear:transition]

bodies:
  - id: astrid
    container: workflow
    fills_roles: [steward]
  - id: ai
    container: ai
    fills_roles: []
  - id: charles
    container: dev
    fills_roles: [dev]
`;

const ASTRID_UUID = "astrid-linear-uuid";
const AI_UUID = "ai-linear-uuid";
const CHARLES_UUID = "charles-linear-uuid";

// Ticket at determining-scope, delegated to astrid (the brief's author).
const SPAWNER_AT_SCOPE = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:determining-scope" }] },
      delegate: { id: ASTRID_UUID },
    },
  },
};

describe("checkWorkflowRules — designated-approver sign-off bypass", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "designated-approver-test-"));
    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    const workflowFile = path.join(tmpDir, "sprint-spawner.yaml");
    fs.writeFileSync(workflowFile, SPAWNER_TEST_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    resetPolicyCache();
    resetWorkflowCache();
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockLabelFetch(SPAWNER_AT_SCOPE);
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

  function mockLabelFetch(labelResponse: object) {
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

  it("ALLOWS the nominated approver (ai, holds sprint:signoff) to fire 'approve' while NOT the delegate", async () => {
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "ai", null, AI_UUID);
    expect(result).toBeNull();
  });

  it("scopes the bypass to the capability-named transition — ai stays delegate-blocked on 'rescope'", async () => {
    const result = await checkWorkflowRules("rescope", "issue-uuid", "Bearer tok", "ai", null, AI_UUID);
    expect(result).not.toBeNull();
    expect(result).toContain("not the current delegate");
  });

  it("requires the explicit designated_approver flag — a bare requires_capability does NOT lift the delegate gate (G-13 AC1 parity)", async () => {
    // ai holds sprint:signoff, but 'bare-capability' lacks designated_approver:
    // the capability holder must still be the delegate to fire it — this is the
    // dev-impl `deploy` shape (requires_capability without the flag).
    const result = await checkWorkflowRules("bare-capability", "issue-uuid", "Bearer tok", "ai", null, AI_UUID);
    expect(result).not.toBeNull();
    expect(result).toContain("not the current delegate");
  });

  it("BLOCKS the delegate/author (astrid) from self-approving — requires_capability gate holds", async () => {
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "astrid", null, ASTRID_UUID);
    expect(result).not.toBeNull();
    expect(result).toContain("sprint:signoff");
  });

  it("BLOCKS a known non-delegate without the capability (charles) on the sign-off transition", async () => {
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "charles", null, CHARLES_UUID);
    expect(result).not.toBeNull();
    expect(result).toContain("not the current delegate");
  });

  it("break-glass holder without the capability still cannot approve (steward non-delegate)", async () => {
    // Delegate is someone else; astrid bypasses the delegate gate via
    // workflow:break-glass but the requires_capability gate must still block.
    globalThis.fetch = mockLabelFetch({
      data: {
        issue: {
          labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:determining-scope" }] },
          delegate: { id: "someone-else-uuid" },
        },
      },
    });
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "astrid", null, ASTRID_UUID);
    expect(result).not.toBeNull();
    expect(result).toContain("sprint:signoff");
  });
});
