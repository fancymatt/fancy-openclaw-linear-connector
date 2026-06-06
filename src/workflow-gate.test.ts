/**
 * Unit tests for workflow-gate enforcement (AI-1352 Phase 3 / B1).
 *
 * Uses minimal in-memory YAML files injected via WORKFLOW_DEF_PATH and
 * CAPABILITY_POLICY_PATH so tests never depend on vault / project paths.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkWorkflowRules,
  resetWorkflowCache,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";

// ── Minimal test capability policy ────────────────────────────────────────
// Includes repo:merge so we can test the merge capability gate.

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: repo:merge

containers:
  - id: dev
    grants: [linear:transition]
  - id: merge-gate
    grants: [linear:transition, repo:merge]
  - id: steward
    grants: [linear:transition, human:escalate]

roles:
  - id: dev
    requires: [linear:transition]
  - id: merge-gate
    requires: [repo:merge]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: hanzo
    container: merge-gate
    fills_roles: [merge-gate]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

// ── Minimal test workflow def ──────────────────────────────────────────────

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake

break_glass:
  command: escape

states:
  - id: intake
    owner_role: steward
    kind: normal
    transitions:
      - command: accept
        to: ready-for-impl
      - command: demote
        to: __ad_hoc__

  - id: ready-for-impl
    owner_role: dev
    kind: normal
    transitions:
      - command: begin
        to: in-progress

  - id: in-progress
    owner_role: dev
    kind: normal
    transitions:
      - command: submit
        to: awaiting-review

  - id: awaiting-review
    owner_role: code-review
    kind: normal
    transitions:
      - command: approve
        to: approved
      - command: request-changes
        to: changes-requested

  - id: changes-requested
    owner_role: dev
    kind: normal
    transitions:
      - command: resubmit
        to: awaiting-review

  - id: approved
    owner_role: merge-gate
    kind: normal
    transitions:
      - command: merge
        to: merged
        requires_capability: repo:merge

  - id: merged
    owner_role: steward
    kind: normal
    transitions:
      - command: close
        to: done

  - id: done
    kind: terminal
    transitions: []
`;

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-gate-test-"));

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const workflowFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = workflowFile;
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLabelFetch(labelNames: string[]): typeof globalThis.fetch {
  return async (_url, _init) => {
    const body = {
      data: {
        issue: {
          labels: { nodes: labelNames.map((name) => ({ name })) },
        },
      },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("checkWorkflowRules — mode switch", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns null when issueId is null (fail open)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:in-progress"]);
    expect(await checkWorkflowRules("submit", null, "Bearer tok", "charles")).toBeNull();
  });

  it("returns null for ad-hoc ticket (no wf:* label) — §4.6 mode switch", async () => {
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);
    expect(await checkWorkflowRules("anything", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("returns null for unknown workflow id (wf:other-workflow) — fail open", async () => {
    globalThis.fetch = makeLabelFetch(["wf:other-workflow", "state:in-progress"]);
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("returns null when label fetch throws — fail open", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("returns null when no state:* label — fail open", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "bug"]);
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });
});

// ── Break-glass ────────────────────────────────────────────────────────────

describe("checkWorkflowRules — break-glass escape", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const allStates = [
    "intake", "ready-for-impl", "in-progress", "awaiting-review",
    "changes-requested", "approved", "merged", "done",
  ];

  for (const state of allStates) {
    it(`escape is always legal from state '${state}' (§4.4)`, async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", `state:${state}`]);
      expect(await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "charles")).toBeNull();
    });
  }
});

// ── Per-state legal / illegal commands ────────────────────────────────────

describe("checkWorkflowRules — intake state", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'accept' in intake", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    expect(await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });

  it("allows 'demote' in intake", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    expect(await checkWorkflowRules("demote", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });

  it("blocks 'submit' in intake", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("submit");
    expect(result).toContain("intake");
    expect(result).toContain("accept");
  });

  it("blocks 'merge' in intake", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    const result = await checkWorkflowRules("merge", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("merge");
    expect(result).toContain("intake");
  });
});

describe("checkWorkflowRules — ready-for-impl state", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'begin' in ready-for-impl", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:ready-for-impl"]);
    expect(await checkWorkflowRules("begin", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("blocks 'merge' in ready-for-impl", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:ready-for-impl"]);
    const result = await checkWorkflowRules("merge", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("ready-for-impl");
  });
});

describe("checkWorkflowRules — in-progress state", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'submit' in in-progress", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:in-progress"]);
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("blocks 'merge' in in-progress", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:in-progress"]);
    const result = await checkWorkflowRules("merge", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
  });

  it("blocks 'approve' in in-progress (not at review)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:in-progress"]);
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("approve");
    expect(result).toContain("in-progress");
    expect(result).toContain("submit");
  });
});

describe("checkWorkflowRules — awaiting-review state", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'approve' in awaiting-review", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:awaiting-review"]);
    expect(await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("allows 'request-changes' in awaiting-review", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:awaiting-review"]);
    expect(await checkWorkflowRules("request-changes", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("blocks 'merge' in awaiting-review", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:awaiting-review"]);
    const result = await checkWorkflowRules("merge", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("awaiting-review");
  });
});

describe("checkWorkflowRules — changes-requested state", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'resubmit' in changes-requested", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:changes-requested"]);
    expect(await checkWorkflowRules("resubmit", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("blocks 'submit' in changes-requested (wrong command — resubmit is correct)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:changes-requested"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("changes-requested");
    expect(result).toContain("resubmit");
  });
});

// ── Merge capability gate (Hanzo-only) ────────────────────────────────────

describe("checkWorkflowRules — merge capability gate (approved state)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'merge' from Hanzo (merge-gate body) in approved state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:approved"]);
    expect(await checkWorkflowRules("merge", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
  });

  it("blocks 'merge' from Charles (dev body, no repo:merge) in approved state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:approved"]);
    const result = await checkWorkflowRules("merge", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("repo:merge");
    expect(result).toContain("merge-gate");
  });

  it("blocks 'merge' from Astrid (steward body, no repo:merge) in approved state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:approved"]);
    const result = await checkWorkflowRules("merge", "issue-uuid", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("repo:merge");
  });

  it("blocks illegal command 'submit' in approved state even for Hanzo", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:approved"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("approved");
    expect(result).toContain("merge");
  });
});

// ── Merged / done states ───────────────────────────────────────────────────

describe("checkWorkflowRules — merged / done states", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'close' in merged state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merged"]);
    expect(await checkWorkflowRules("close", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });

  it("blocks 'merge' in merged state (already merged)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merged"]);
    const result = await checkWorkflowRules("merge", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
  });

  it("blocks any non-escape command in done state (terminal)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:done"]);
    const result = await checkWorkflowRules("close", "issue-uuid", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("done");
  });

  it("escape is still legal in done state (§4.4)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:done"]);
    expect(await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });
});

// ── Error message content ──────────────────────────────────────────────────

describe("checkWorkflowRules — error message format", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("names the legal moves in the rejection for an illegal command", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:in-progress"]);
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "charles");
    expect(result).toContain("submit");
    expect(result).toContain("escape");
  });
});
