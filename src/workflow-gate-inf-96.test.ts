/**
 * INF-96: done-gate regression tests — zero GitHub evidence must block, not
 * fail-open. Every assertion in this file contradicts the current AI-1497
 * fail-open behavior and will fail (red) until the gate is hardened.
 *
 * Acceptance criteria:
 * 1. Zero GitHub PR/branch evidence → hard fail (or explicit human-review flag)
 * 2. Missing Linear↔GitHub integration surfaces as loud actionable alert
 * 3. No ticket reaches `done` via merge/deploy without verifiable merged-PR
 * 4. Regression: merged PR with auto-deleted branch (AI-1492) still passes
 *
 * Design (per Astrid intake): integration-present check gates the evidence
 * path; absent integration → hard-block with runbook; present + no evidence →
 * hard-block; AI-1492 merged-PR-without-branch still pass.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  checkWorkflowRules,
  applyStateTransition,
  resetWorkflowCache,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { _resetAlertBusForTests } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";

const CANONICAL_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");

// ── Minimal test capability policy (from main test file) ──

const TEST_POLICY_YAML = [
  "capabilities:",
  '  - id: linear:transition',
  '  - id: human:escalate',
  '  - id: workflow:break-glass',
  '  - id: deploy:execute',
  '  - id: infra:ssh',
  "",
  "containers:",
  '  - id: dev',
  '    grants: [linear:transition]',
  '  - id: deployment',
  '    grants: [linear:transition, deploy:execute, infra:ssh]',
  '  - id: steward',
  '    grants: [linear:transition, human:escalate, workflow:break-glass]',
  '  - id: code-review',
  '    grants: [linear:transition]',
  "",
  "roles:",
  '  - id: dev',
  '    requires: [linear:transition]',
  '  - id: worker',
  '    requires: [linear:transition]',
  '  - id: deployment',
  '    requires: [deploy:execute]',
  '  - id: steward',
  '    requires: [human:escalate]',
  '  - id: code-review',
  '    requires: [linear:transition]',
  "",
  "bodies:",
  '  - id: hanzo',
  '    container: deployment',
  '    fills_roles: [deployment]',
  '  - id: charles',
  '    container: dev',
  '    fills_roles: [dev]',
  '  - id: astrid',
  '    container: steward',
  '    fills_roles: [steward]',
  '  - id: reviewer',
  '    container: code-review',
  '    fills_roles: [code-review]',
  '  - id: worker1',
  '    container: dev',
  '    fills_roles: [worker]',
  '  - id: worker2',
  '    container: dev',
  '    fills_roles: [worker]',
].join("\n");

// ── Helper: build mock responses ──────────────────────────

function jsonResponse(obj: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TEAM_STATES_DATA = {
  data: {
    team: {
      states: {
        nodes: [
          { id: "state-backlog-uuid", name: "Backlog", type: "unstarted" },
          { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
          { id: "state-doing-uuid", name: "Doing", type: "started" },
          { id: "state-thinking-uuid", name: "Thinking", type: "started" },
          { id: "state-managing-uuid", name: "Managing", type: "started" },
          { id: "state-done-uuid", name: "Done", type: "completed" },
          { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
        ],
      },
    },
  },
};

const EMPTY_ATTACHMENTS = {
  data: { issue: { attachments: { nodes: [] as Array<Record<string, unknown>> } } },
};

// ── Fixture setup ─────────────────────────────────────────

let policyDir: string;
let originalWorkflowPath: string | undefined;
let originalPolicyPath: string | undefined;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
  process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
  resetWorkflowCache();

  policyDir = fs.mkdtempSync("inf96-policy-");
  const policyFile = path.join(policyDir, "policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
  process.env.CAPABILITY_POLICY_PATH = policyFile;
  resetPolicyCache();
});

afterAll(() => {
  if (originalWorkflowPath !== undefined) {
    process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
  } else {
    delete process.env.WORKFLOW_DEF_PATH;
  }
  if (originalPolicyPath !== undefined) {
    process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
  } else {
    delete process.env.CAPABILITY_POLICY_PATH;
  }
  resetWorkflowCache();
  resetPolicyCache();
  fs.rmSync(policyDir, { recursive: true, force: true });
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── AC 1 + AC 4: Zero evidence → hard fail ────────────────

describe("INF-96 AC1+AC4: checkWorkflowRules — zero evidence blocks (no fail-open)", () => {

  it("blocks 'continue' from merge state when no branch/PR evidence exists (INF-96)", async () => {
    // Zero evidence via empty attachments
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const query = parsed.query ?? "";

      if (query.includes("TeamStates")) return jsonResponse(TEAM_STATES_DATA);
      if (query.includes("delegate") || query.includes("IssueContext")) {
        return jsonResponse({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:merge" }] },
              delegate: null,
            },
          },
        });
      }
      if (query.includes("IssueBranchAndPR")) return jsonResponse(EMPTY_ATTACHMENTS);

      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    // Assert the gate BLOCKS (returns a string, not null) — contradicts current pass
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    expect(result!).toContain("blocked");
  });

  it("blocks 'continue' from deploy state when no branch/PR evidence exists (INF-96)", async () => {
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const query = parsed.query ?? "";

      if (query.includes("TeamStates")) return jsonResponse(TEAM_STATES_DATA);
      if (query.includes("delegate") || query.includes("IssueContext")) {
        return jsonResponse({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deploy" }] },
              delegate: null,
            },
          },
        });
      }
      if (query.includes("IssueBranchAndPR")) return jsonResponse(EMPTY_ATTACHMENTS);

      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    expect(result!).toContain("blocked");
  });

  it("blocks 'continue' from merge state with no evidence, even after retry (INF-96)", async () => {
    let queryCount = 0;
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const query = parsed.query ?? "";

      if (query.includes("TeamStates")) return jsonResponse(TEAM_STATES_DATA);
      if (query.includes("delegate") || query.includes("IssueContext")) {
        return jsonResponse({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:merge" }] },
              delegate: null,
            },
          },
        });
      }
      if (query.includes("IssueBranchAndPR")) {
        queryCount++;
        return jsonResponse(EMPTY_ATTACHMENTS);
      }

      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result!).toContain("blocked");
    expect(queryCount).toBeGreaterThanOrEqual(1);
  });
});

// ── AC 2: Missing integration → loud actionable alert ────

describe("INF-96 AC2: missing GitHub integration surfaces as loud actionable alert", () => {

  it("emits an alert with actionable runbook guidance when zero evidence found", async () => {
    _resetAlertBusForTests();
    const alertStore = new AlertStore(":memory:");
    const { initAlertBus } = await import("./alerts/alert-bus.js");
    initAlertBus({ store: alertStore, pushEnabled: false });

    try {
      globalThis.fetch = async (_url, init) => {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        const parsed = JSON.parse(bodyText) as { query?: string };
        const query = parsed.query ?? "";

        if (query.includes("TeamStates")) return jsonResponse(TEAM_STATES_DATA);
        if (query.includes("delegate") || query.includes("IssueContext")) {
          return jsonResponse({
            data: {
              issue: {
                labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:merge" }] },
                delegate: null,
              },
            },
          });
        }
        if (query.includes("IssueBranchAndPR")) return jsonResponse(EMPTY_ATTACHMENTS);

        throw new Error(`unexpected query: ${query.slice(0, 80)}`);
      };

      await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");

      const doneAlerts = alertStore.query({ source: "done-gate" });
      expect(doneAlerts.length).toBeGreaterThanOrEqual(1);

      const noEvidenceAlert = doneAlerts.find(
        (a) => a.dedupKey === "done-gate|no-evidence" || (a.title && a.title.toLowerCase().includes("no github"))
      );
      expect(noEvidenceAlert).toBeDefined();

      // The alert must contain actionable guidance (runbook pointer or install instructions).
      const alertText = [noEvidenceAlert!.title, noEvidenceAlert!.detail].filter(Boolean).join(" ");
      const hasRunbook = /runbook|install|reinstall|integration|reconnect|setup/i.test(alertText);
      expect(hasRunbook).toBe(true);
    } finally {
      _resetAlertBusForTests();
    }
  });
});

// ── AC 3: No done without verifiable merged-PR ────────────

describe("INF-96 AC3: cannot reach done without verifiable merged-PR reference", () => {

  it("blocks 'continue' from deploy state when only an open PR exists (not merged)", async () => {
    const openPRAttachment = {
      data: {
        issue: {
          attachments: {
            nodes: [
              { url: "https://github.com/fancymatt/repo/pull/1", sourceType: "github", metadata: { status: "open" } },
            ],
          },
        },
      },
    };

    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const query = parsed.query ?? "";

      if (query.includes("TeamStates")) return jsonResponse(TEAM_STATES_DATA);
      if (query.includes("delegate") || query.includes("IssueContext")) {
        return jsonResponse({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deploy" }] },
              delegate: null,
            },
          },
        });
      }
      if (query.includes("IssueBranchAndPR")) return jsonResponse(openPRAttachment);

      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    // Current code allows open PRs through the gate. INF-96 AC3 says a ticket
    // cannot reach done without a VERIFIABLE MERGED PR. Open PR → must block.
    expect(result).not.toBeNull();
    expect(result!).toContain("blocked");
  });

  it("allows 'continue' from merge state when merged PR is confirmed (AI-1492 preserved)", async () => {
    const mergedPRAttachment = {
      data: {
        issue: {
          attachments: {
            nodes: [
              { url: "https://github.com/fancymatt/repo/pull/1", sourceType: "github", metadata: { status: "merged" } },
            ],
          },
        },
      },
    };

    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const query = parsed.query ?? "";

      if (query.includes("TeamStates")) return jsonResponse(TEAM_STATES_DATA);
      if (query.includes("delegate") || query.includes("IssueContext")) {
        return jsonResponse({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:merge" }] },
              delegate: null,
            },
          },
        });
      }
      if (query.includes("IssueBranchAndPR")) return jsonResponse(mergedPRAttachment);

      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    // Merged PR → must pass (AI-1492).
    expect(result).toBeNull();
  });

  it("allows 'continue' from deploy state when merged PR is confirmed (AI-1492 preserved)", async () => {
    const mergedPRAttachment = {
      data: {
        issue: {
          attachments: {
            nodes: [
              { url: "https://github.com/fancymatt/repo/pull/1", sourceType: "github", metadata: { status: "merged" } },
            ],
          },
        },
      },
    };

    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const query = parsed.query ?? "";

      if (query.includes("TeamStates")) return jsonResponse(TEAM_STATES_DATA);
      if (query.includes("delegate") || query.includes("IssueContext")) {
        return jsonResponse({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deploy" }] },
              delegate: null,
            },
          },
        });
      }
      if (query.includes("IssueBranchAndPR")) return jsonResponse(mergedPRAttachment);

      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).toBeNull(); // Merged PR → must pass
  });
});

// ── AC 4 (defense-in-depth): applyStateTransition also blocks ──

describe("INF-96 AC4: applyStateTransition — zero evidence blocks", () => {

  it("blocks label swap from merge state when no branch/PR evidence exists (INF-96)", async () => {
    const expectedDeployLabel = {
      data: { team: { labels: { nodes: [{ id: "dep-lbl", name: "state:deploy" }] } } },
    };

    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const query = parsed.query ?? "";

      if (query.includes("IssueWithLabels")) {
        return jsonResponse({
          data: {
            issue: {
              id: "internal-uuid",
              team: { id: "team-uuid" },
              labels: { nodes: [
                { id: "wf-lbl", name: "wf:dev-impl" },
                { id: "state-lbl", name: "state:merge" },
              ] },
            },
          },
        });
      }
      if (query.includes("TeamStates")) return jsonResponse(TEAM_STATES_DATA);
      if (query.includes("TeamLabels")) return jsonResponse(expectedDeployLabel);
      if (query.includes("IssueBranchAndPR")) return jsonResponse(EMPTY_ATTACHMENTS);

      // Fail if ApplyAtomicTransition is reached (gate should have blocked before it)
      if (query.includes("ApplyAtomicTransition")) {
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      }
      if (query.includes("UpdateDelegate")) {
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      }
      if (query.includes("issueLabelCreate")) {
        return jsonResponse({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label" } } } });
      }

      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    const result = await applyStateTransition("continue", "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("status", "blocked");
    expect(result).toHaveProperty("code", "release-gate");
  });

  it("blocks label swap from deploy state when no branch/PR evidence exists (INF-96)", async () => {
    const expectedAcvLabel = {
      data: { team: { labels: { nodes: [{ id: "acv-lbl", name: "state:ac-validate" }] } } },
    };

    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const query = parsed.query ?? "";

      if (query.includes("IssueWithLabels")) {
        return jsonResponse({
          data: {
            issue: {
              id: "internal-uuid",
              team: { id: "team-uuid" },
              labels: { nodes: [
                { id: "wf-lbl", name: "wf:dev-impl" },
                { id: "state-lbl", name: "state:deploy" },
              ] },
            },
          },
        });
      }
      if (query.includes("TeamStates")) return jsonResponse(TEAM_STATES_DATA);
      if (query.includes("TeamLabels")) return jsonResponse(expectedAcvLabel);
      if (query.includes("IssueBranchAndPR")) return jsonResponse(EMPTY_ATTACHMENTS);

      if (query.includes("ApplyAtomicTransition")) {
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      }
      if (query.includes("UpdateDelegate")) {
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      }
      if (query.includes("issueLabelCreate")) {
        return jsonResponse({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label" } } } });
      }

      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    const result = await applyStateTransition("continue", "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("status", "blocked");
    expect(result).toHaveProperty("code", "release-gate");
  });

  it("preserves AI-1492: merged PR with auto-deleted branch still passes applyStateTransition", async () => {
    const mergedPRAttachment = {
      data: {
        issue: {
          attachments: {
            nodes: [
              { url: "https://github.com/fancymatt/repo/pull/1", sourceType: "github", metadata: { status: "merged" } },
            ],
          },
        },
      },
    };
    const expectedDeployLabel = {
      data: { team: { labels: { nodes: [{ id: "dep-lbl", name: "state:deploy" }] } } },
    };

    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const query = parsed.query ?? "";

      if (query.includes("IssueWithLabels")) {
        return jsonResponse({
          data: {
            issue: {
              id: "internal-uuid",
              team: { id: "team-uuid" },
              labels: { nodes: [
                { id: "wf-lbl", name: "wf:dev-impl" },
                { id: "state-lbl", name: "state:merge" },
              ] },
            },
          },
        });
      }
      if (query.includes("TeamStates")) return jsonResponse(TEAM_STATES_DATA);
      if (query.includes("TeamLabels")) return jsonResponse(expectedDeployLabel);
      if (query.includes("IssueBranchAndPR")) return jsonResponse(mergedPRAttachment);

      if (query.includes("ApplyAtomicTransition")) {
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      }
      if (query.includes("UpdateDelegate")) {
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      }
      if (query.includes("issueLabelCreate")) {
        return jsonResponse({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label" } } } });
      }

      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    const result = await applyStateTransition("continue", "issue-uuid", "Bearer tok");
    // Merged PR with deleted branch → must still pass (AI-1492).
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("code", "release-gate");
  });
});
