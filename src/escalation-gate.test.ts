/**
 * Unit tests for escalation-gate enforcement (AI-1346).
 *
 * Uses a minimal in-memory capability policy injected via CAPABILITY_POLICY_PATH
 * so tests never depend on the vault file system path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bodyHasCapability,
  checkEnforcementRules,
  ENFORCEMENT_RULES,
  resetPolicyCache,
} from "./escalation-gate.js";

// ── Minimal test policy ───────────────────────────────────────────────────

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]
  - id: main-agent
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: []
  - id: ai
    openclaw_agent: main
    container: main-agent
    fills_roles: []
`;

let policyFile: string;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escalation-gate-test-"));
  policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;
});

beforeEach(() => {
  resetPolicyCache();
});

// ── ENFORCEMENT_RULES shape ───────────────────────────────────────────────

describe("ENFORCEMENT_RULES", () => {
  it("includes the needs-human rule", () => {
    const rule = ENFORCEMENT_RULES.find((r) => r.intent === "needs-human");
    expect(rule).toBeDefined();
    expect(rule?.requiredCapability).toBe("human:escalate");
  });
});

// ── bodyHasCapability ─────────────────────────────────────────────────────

describe("bodyHasCapability", () => {
  it("returns true for astrid with human:escalate", async () => {
    expect(await bodyHasCapability("astrid", "human:escalate")).toBe(true);
  });

  it("returns true for astrid with linear:transition", async () => {
    expect(await bodyHasCapability("astrid", "linear:transition")).toBe(true);
  });

  it("returns false for charles with human:escalate", async () => {
    expect(await bodyHasCapability("charles", "human:escalate")).toBe(false);
  });

  it("returns true for charles with linear:transition", async () => {
    expect(await bodyHasCapability("charles", "linear:transition")).toBe(true);
  });

  it("returns false for unknown body", async () => {
    expect(await bodyHasCapability("unknown-body", "human:escalate")).toBe(false);
  });

  // AI-1348: runtime sends OPENCLAW_MCP_AGENT_ID=main but policy body id is ai
  it("resolves main (openclaw_agent alias) to ai body capabilities", async () => {
    expect(await bodyHasCapability("main", "linear:transition")).toBe(true);
    expect(await bodyHasCapability("main", "human:escalate")).toBe(false);
  });
});

// ── checkEnforcementRules ─────────────────────────────────────────────────

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

describe("checkEnforcementRules", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null for an intent with no matching rule", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-1"]);
    const result = await checkEnforcementRules("begin-work", "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("returns null when issueId is null (fail open)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-1"]);
    const result = await checkEnforcementRules("needs-human", null, "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("returns null when ticket has no wf:* label (ad-hoc — §4.6 mode switch)", async () => {
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);
    const result = await checkEnforcementRules("needs-human", "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("returns rejection message when non-steward runs needs-human on workflow ticket", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-1", "bug"]);
    const result = await checkEnforcementRules("needs-human", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("needs-human");
    expect(result).toContain("human:escalate");
    expect(result).toContain("steward");
  });

  it("returns null when steward (Astrid) runs needs-human on workflow ticket", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-1"]);
    const result = await checkEnforcementRules("needs-human", "issue-uuid", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("fails open when label fetch throws", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };
    const result = await checkEnforcementRules("needs-human", "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("is case-insensitive for wf: label matching", async () => {
    // Labels should match regardless of case
    globalThis.fetch = makeLabelFetch(["WF:sprint-1"]);
    const result = await checkEnforcementRules("needs-human", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
  });
});
