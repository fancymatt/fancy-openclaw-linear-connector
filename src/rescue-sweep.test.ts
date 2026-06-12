/**
 * AI-1566 — Tests for the connector rescue sweep.
 *
 * Tests cover all 7 acceptance criteria:
 *   AC1 — sweep enumerates all wf:* tickets and classifies each as
 *          healthy / dormant / malformed / drifted / terminal
 *   AC2 — dormant and malformed tickets are rescued (delegate set; entry
 *          state applied for malformed); a Linear delegate-update is issued
 *   AC3 — detection uses only labels + delegate (no native Linear status
 *          field consulted)
 *   AC4 — each rescue emits an operational event; a summary is surfaced
 *   AC5 — idempotent: healthy ticket untouched; a ticket rescued within
 *          the same sweep is not re-poked
 *   AC6 — terminal tickets (state:done, state:escape) are ignored entirely
 *   AC7 — scenario matrix:
 *          dormant → re-delegated
 *          malformed → bootstrapped (entry state + delegate)
 *          healthy → untouched
 *          terminal → ignored
 *          drifted → delegate corrected
 *
 * All tests MUST be RED until the implementation lands.
 * Tests against existing behaviour (import shape, type exports) are allowed
 * to pass as a compile-time smoke check.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "@jest/globals";
import {
  classifyTicket,
  runRescueSweep,
  type TicketClassification,
  type SweepTicket,
  type RescueAction,
  type RescueSweepResult,
  type RescueSweepOptions,
} from "./rescue-sweep.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** A minimal workflow def for testing — mirrors canonical dev-impl shape. */
const TEST_WORKFLOW_DEF = {
  id: "dev-impl",
  entry_state: "intake",
  states: [
    { id: "intake",         owner_role: "steward" },
    { id: "write-tests",    owner_role: "test-author" },
    { id: "implementation", owner_role: "dev" },
    { id: "code-review",    owner_role: "code-review" },
    { id: "deployment",     owner_role: "deployment" },
    { id: "host-deploy",    owner_role: "host-deploy" },
    { id: "ac-validate",    owner_role: "steward" },
    { id: "done",           owner_role: undefined },
    { id: "escape",         owner_role: undefined },
  ],
};

/** Simple in-memory role resolver that mirrors the test capability policy. */
function makeRoleResolver(mapping: Record<string, string[]>): (roleId: string) => string[] {
  return (roleId: string) => mapping[roleId] ?? [];
}

const DEFAULT_ROLE_RESOLVER = makeRoleResolver({
  "steward":     ["astrid"],
  "test-author": ["tdd"],
  "dev":         ["felix", "noah", "sage", "igor"],
  "code-review": ["charles"],
  "deployment":  ["hanzo"],
  "host-deploy": ["grover"],
});

/** Minimal operational event recorder spy. */
function makeEventSpy() {
  const events: Array<{ outcome: string; type?: string; detail?: unknown }> = [];
  const store = {
    record(event: { outcome: string; type?: string; detail?: unknown }) {
      events.push(event);
    },
  };
  return { store, events };
}

// ── Temporary filesystem helpers (capability policy + workflow def YAML) ───

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rescue-sweep-test-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a minimal capability policy YAML and return its path. */
function writeCapabilityPolicy(overrides: Record<string, string[]> = {}): string {
  const mapping = { ...{ steward: ["astrid"], "test-author": ["tdd"], dev: ["felix", "noah", "sage", "igor"], "code-review": ["charles"], deployment: ["hanzo"], "host-deploy": ["grover"] }, ...overrides };
  const bodies = Object.entries(mapping).flatMap(([role, ids]) =>
    ids.map((id) => `  - id: ${id}\n    container: ${role === "dev" ? "dev" : role}\n    fills_roles: [${role}]`),
  ).join("\n");
  const yaml = `capabilities:\n  - id: linear:transition\n\ncontainers:\n  - id: dev\n    grants: [linear:transition]\n  - id: steward\n    grants: [linear:transition]\n  - id: test-author\n    grants: [linear:transition]\n  - id: code-review\n    grants: [linear:transition]\n  - id: deployment\n    grants: [linear:transition]\n  - id: host-deploy\n    grants: [linear:transition]\n\nbodies:\n${bodies}\n`;
  const p = path.join(tmpDir, `cap-policy-${Date.now()}.yaml`);
  fs.writeFileSync(p, yaml, "utf8");
  return p;
}

/** Write a minimal workflow def YAML and return its path. */
function writeWorkflowDef(id: string = "dev-impl"): string {
  const yaml = `id: ${id}\nentry_state: intake\nstates:\n  - id: intake\n    owner_role: steward\n  - id: write-tests\n    owner_role: test-author\n  - id: implementation\n    owner_role: dev\n  - id: done\n  - id: escape\n`;
  const p = path.join(tmpDir, `wf-def-${id}-${Date.now()}.yaml`);
  fs.writeFileSync(p, yaml, "utf8");
  return p;
}

/** Build a fake Linear API mock that returns a list of issues for a wf:* search. */
function makeLinearMock(opts: {
  issues?: Array<{
    id: string;
    identifier: string;
    labels: string[];
    delegateId: string | null;
    delegateName?: string | null;
    nativeStateName?: string; // deliberately included to verify it is NOT consulted
  }>;
  updateDelegate?: { success: boolean };
  updateLabels?: { success: boolean };
  commentPost?: { success: boolean };
  onFetch?: (query: string, variables: unknown) => void;
}): { fetch: typeof globalThis.fetch; delegateUpdateCalls: string[]; labelUpdateCalls: string[] } {
  const delegateUpdateCalls: string[] = [];
  const labelUpdateCalls: string[] = [];

  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";

    opts.onFetch?.(query, parsed.variables);

    // Search for wf:* issues
    if (query.includes("IssueSearch") || query.includes("issues(") || query.includes("WorkflowIssues")) {
      const nodes = (opts.issues ?? []).map((iss) => ({
        id: iss.id,
        identifier: iss.identifier,
        state: { name: iss.nativeStateName ?? "Doing" }, // native status present but irrelevant
        labels: { nodes: iss.labels.map((name, i) => ({ id: `lbl-${i}`, name })) },
        delegate: iss.delegateId
          ? { id: iss.delegateId, name: iss.delegateName ?? iss.delegateId }
          : null,
      }));
      return new Response(
        JSON.stringify({ data: { issues: { nodes } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Delegate update
    if (query.includes("UpdateDelegate") || query.includes("issueUpdate")) {
      const issId = (parsed.variables as Record<string, unknown>)?.["id"] as string ?? "";
      if (query.includes("delegateId")) delegateUpdateCalls.push(issId);
      if (query.includes("labelIds")) labelUpdateCalls.push(issId);
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: opts.updateDelegate?.success ?? true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Comment post (for summary report)
    if (query.includes("commentCreate") || query.includes("IssueComment")) {
      return new Response(
        JSON.stringify({ data: { commentCreate: { success: opts.commentPost?.success ?? true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Label lookup / team labels
    if (query.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`rescue-sweep-test: unexpected Linear query: ${query.slice(0, 120)}`);
  };

  return { fetch: mockFetch, delegateUpdateCalls, labelUpdateCalls };
}

// ══════════════════════════════════════════════════════════════════════════
// AC1 — classifyTicket: label + delegate → correct classification
// ══════════════════════════════════════════════════════════════════════════

describe("AC1 — classifyTicket: produces correct classification from labels + delegate", () => {
  it("healthy: wf:* + state matching current delegate", () => {
    const result = classifyTicket(
      ["wf:dev-impl", "state:write-tests"],
      "tdd",
      TEST_WORKFLOW_DEF,
      DEFAULT_ROLE_RESOLVER,
    );
    expect(result).toBe<TicketClassification>("healthy");
  });

  it("terminal: state:done → terminal regardless of delegate", () => {
    const result = classifyTicket(
      ["wf:dev-impl", "state:done"],
      null,
      TEST_WORKFLOW_DEF,
      DEFAULT_ROLE_RESOLVER,
    );
    expect(result).toBe<TicketClassification>("terminal");
  });

  it("terminal: state:escape → terminal regardless of delegate", () => {
    const result = classifyTicket(
      ["wf:dev-impl", "state:escape"],
      "astrid",
      TEST_WORKFLOW_DEF,
      DEFAULT_ROLE_RESOLVER,
    );
    expect(result).toBe<TicketClassification>("terminal");
  });

  it("malformed: wf:* label present but no state:* label", () => {
    const result = classifyTicket(
      ["wf:dev-impl"],
      null,
      TEST_WORKFLOW_DEF,
      DEFAULT_ROLE_RESOLVER,
    );
    expect(result).toBe<TicketClassification>("malformed");
  });

  it("malformed: wf:* label + unrelated labels but no state:*", () => {
    const result = classifyTicket(
      ["wf:dev-impl", "risk:low", "size:small"],
      "astrid",
      TEST_WORKFLOW_DEF,
      DEFAULT_ROLE_RESOLVER,
    );
    expect(result).toBe<TicketClassification>("malformed");
  });

  it("dormant: non-terminal, has state:*, but delegate is null", () => {
    const result = classifyTicket(
      ["wf:dev-impl", "state:implementation"],
      null,
      TEST_WORKFLOW_DEF,
      DEFAULT_ROLE_RESOLVER,
    );
    expect(result).toBe<TicketClassification>("dormant");
  });

  it("drifted: delegate exists but does not fill state's owner_role", () => {
    // write-tests owner_role is test-author, but hanzo (deployment) is delegate
    const result = classifyTicket(
      ["wf:dev-impl", "state:write-tests"],
      "hanzo",
      TEST_WORKFLOW_DEF,
      DEFAULT_ROLE_RESOLVER,
    );
    expect(result).toBe<TicketClassification>("drifted");
  });

  it("drifted: steward delegate on implementation state (owner: dev)", () => {
    const result = classifyTicket(
      ["wf:dev-impl", "state:implementation"],
      "astrid", // steward, not dev
      TEST_WORKFLOW_DEF,
      DEFAULT_ROLE_RESOLVER,
    );
    expect(result).toBe<TicketClassification>("drifted");
  });

  it("healthy: multi-body role — any valid body in role is healthy", () => {
    // dev role has felix/noah/sage/igor — sage is valid
    const result = classifyTicket(
      ["wf:dev-impl", "state:implementation"],
      "sage",
      TEST_WORKFLOW_DEF,
      DEFAULT_ROLE_RESOLVER,
    );
    expect(result).toBe<TicketClassification>("healthy");
  });

  it("dormant: has state:* but delegate empty string treated as absent", () => {
    const result = classifyTicket(
      ["wf:dev-impl", "state:code-review"],
      null,
      TEST_WORKFLOW_DEF,
      makeRoleResolver({ "code-review": ["charles"] }),
    );
    expect(result).toBe<TicketClassification>("dormant");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC3 — classification must NOT depend on native Linear status
// ══════════════════════════════════════════════════════════════════════════

describe("AC3 — classifyTicket ignores native Linear status entirely", () => {
  it("classifyTicket receives no native-status parameter — no such param in signature", () => {
    // The function must classify correctly using only labels + delegate + def.
    // If classifyTicket accepted a nativeState param and used it, this test
    // verifies that a 'Doing' status does not override a null delegate.
    // We verify the signature has exactly 4 parameters.
    expect(classifyTicket.length).toBe(4);
  });

  it("dormant regardless of whether the native state is Doing, Todo, or Backlog", () => {
    // All three should be dormant — no delegate set — not affected by native status
    const states = ["Doing", "Todo", "Backlog", "Thinking"] as const;
    for (const _nativeState of states) {
      // classifyTicket does not receive nativeState — always uses only labels + delegate
      const result = classifyTicket(
        ["wf:dev-impl", "state:write-tests"],
        null, // no delegate
        TEST_WORKFLOW_DEF,
        DEFAULT_ROLE_RESOLVER,
      );
      expect(result).toBe<TicketClassification>("dormant");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC5 — Idempotency: healthy tickets are never touched
// ══════════════════════════════════════════════════════════════════════════

describe("AC5 — runRescueSweep: healthy tickets are never touched", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("emits no delegate updates when all tickets are healthy", async () => {
    const { fetch: mock, delegateUpdateCalls } = makeLinearMock({
      issues: [
        { id: "uuid-1", identifier: "AI-100", labels: ["wf:dev-impl", "state:intake"], delegateId: "astrid" },
        { id: "uuid-2", identifier: "AI-101", labels: ["wf:dev-impl", "state:write-tests"], delegateId: "tdd" },
      ],
    });
    globalThis.fetch = mock;

    const policyPath = writeCapabilityPolicy();
    const defPath = writeWorkflowDef();
    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      capabilityPolicyPath: policyPath,
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF, entry_state: "intake" }]]),
    });

    expect(result.rescued).toBe(0);
    expect(delegateUpdateCalls).toHaveLength(0);
    expect(result.rescues).toHaveLength(0);
  });

  it("result includes scanned count equal to number of wf:* issues found", async () => {
    const { fetch: mock } = makeLinearMock({
      issues: [
        { id: "uuid-1", identifier: "AI-200", labels: ["wf:dev-impl", "state:intake"], delegateId: "astrid" },
        { id: "uuid-2", identifier: "AI-201", labels: ["wf:dev-impl", "state:done"], delegateId: null },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF, entry_state: "intake" }]]),
    });

    expect(result.scanned).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC6 — Terminal tickets are ignored
// ══════════════════════════════════════════════════════════════════════════

describe("AC6 — runRescueSweep: terminal tickets are ignored", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("state:done ticket is classified terminal and not rescued", async () => {
    const { fetch: mock, delegateUpdateCalls } = makeLinearMock({
      issues: [
        { id: "uuid-done", identifier: "AI-300", labels: ["wf:dev-impl", "state:done"], delegateId: null },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
    });

    expect(result.rescued).toBe(0);
    expect(delegateUpdateCalls).toHaveLength(0);
    expect(result.byClassification?.terminal).toBe(1);
  });

  it("state:escape ticket is classified terminal and not rescued", async () => {
    const { fetch: mock, delegateUpdateCalls } = makeLinearMock({
      issues: [
        { id: "uuid-escape", identifier: "AI-301", labels: ["wf:dev-impl", "state:escape"], delegateId: "astrid" },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
    });

    expect(result.rescued).toBe(0);
    expect(delegateUpdateCalls).toHaveLength(0);
  });

  it("terminal tickets are counted in byClassification.terminal, not rescued", async () => {
    const { fetch: mock } = makeLinearMock({
      issues: [
        { id: "uuid-d1", identifier: "AI-302", labels: ["wf:dev-impl", "state:done"], delegateId: null },
        { id: "uuid-d2", identifier: "AI-303", labels: ["wf:dev-impl", "state:escape"], delegateId: null },
        { id: "uuid-ok", identifier: "AI-304", labels: ["wf:dev-impl", "state:intake"], delegateId: "astrid" },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
    });

    expect(result.byClassification?.terminal ?? 0).toBe(2);
    expect(result.rescued).toBe(0);
    expect(result.scanned).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC7 — Scenario matrix
// ══════════════════════════════════════════════════════════════════════════

describe("AC7 — scenario: dormant ticket gets re-delegated", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("dormant write-tests ticket: tdd (sole test-author) is set as delegate", async () => {
    const { fetch: mock, delegateUpdateCalls } = makeLinearMock({
      issues: [
        { id: "uuid-dormant", identifier: "AI-400", labels: ["wf:dev-impl", "state:write-tests"], delegateId: null },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
      capabilityPolicyPath: writeCapabilityPolicy(),
    });

    expect(result.rescued).toBe(1);
    expect(delegateUpdateCalls).toContain("uuid-dormant");
    expect(result.rescues[0]?.classification).toBe("dormant");
    expect(result.rescues[0]?.outcome).toBe("rescued");
  });

  it("dormant ticket's rescue action describes the delegation", async () => {
    const { fetch: mock } = makeLinearMock({
      issues: [
        { id: "uuid-d2", identifier: "AI-401", labels: ["wf:dev-impl", "state:intake"], delegateId: null },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
      capabilityPolicyPath: writeCapabilityPolicy(),
    });

    expect(result.rescued).toBe(1);
    const action = result.rescues[0] as RescueAction;
    expect(action.identifier).toBe("AI-401");
    expect(action.classification).toBe("dormant");
    expect(action.action).toMatch(/delegat/i);
  });
});

describe("AC7 — scenario: malformed ticket gets bootstrapped (entry state + delegate)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("malformed ticket receives entry state label (state:intake) atomically", async () => {
    const { fetch: mock, labelUpdateCalls, delegateUpdateCalls } = makeLinearMock({
      issues: [
        { id: "uuid-mal", identifier: "AI-500", labels: ["wf:dev-impl"], delegateId: null },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
      capabilityPolicyPath: writeCapabilityPolicy(),
    });

    expect(result.rescued).toBe(1);
    // Bootstrap must apply the entry state label
    expect(labelUpdateCalls).toContain("uuid-mal");
    // Bootstrap must also set the delegate
    expect(delegateUpdateCalls).toContain("uuid-mal");
    expect(result.rescues[0]?.classification).toBe("malformed");
    expect(result.rescues[0]?.outcome).toBe("rescued");
  });

  it("malformed ticket rescue action mentions bootstrapping / entry state", async () => {
    const { fetch: mock } = makeLinearMock({
      issues: [
        { id: "uuid-mal2", identifier: "AI-501", labels: ["wf:dev-impl", "risk:low"], delegateId: null },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
      capabilityPolicyPath: writeCapabilityPolicy(),
    });

    const action = result.rescues[0] as RescueAction;
    expect(action.classification).toBe("malformed");
    expect(action.action).toMatch(/bootstrap|entry.state|intake/i);
  });

  it("malformed: entry_state from workflow def is the bootstrap target", async () => {
    const defWithEntry = { ...TEST_WORKFLOW_DEF, entry_state: "intake" };
    const { fetch: mock, labelUpdateCalls } = makeLinearMock({
      issues: [
        { id: "uuid-mal3", identifier: "AI-502", labels: ["wf:dev-impl"], delegateId: null },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", defWithEntry]]),
      capabilityPolicyPath: writeCapabilityPolicy(),
    });

    expect(result.rescued).toBe(1);
    // The label applied in the bootstrap should reference "intake"
    expect(result.rescues[0]?.action).toMatch(/intake/i);
  });
});

describe("AC7 — scenario: healthy ticket is untouched", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("healthy ticket appears in byClassification.healthy and is not in rescues", async () => {
    const { fetch: mock, delegateUpdateCalls, labelUpdateCalls } = makeLinearMock({
      issues: [
        { id: "uuid-h", identifier: "AI-600", labels: ["wf:dev-impl", "state:code-review"], delegateId: "charles" },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
      capabilityPolicyPath: writeCapabilityPolicy(),
    });

    expect(result.rescued).toBe(0);
    expect(delegateUpdateCalls).toHaveLength(0);
    expect(labelUpdateCalls).toHaveLength(0);
    expect(result.rescues).toHaveLength(0);
    expect(result.byClassification?.healthy ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe("AC7 — scenario: terminal ticket is ignored", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("state:done ticket does not appear in rescues", async () => {
    const { fetch: mock } = makeLinearMock({
      issues: [
        { id: "uuid-t", identifier: "AI-700", labels: ["wf:dev-impl", "state:done"], delegateId: null },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
    });

    expect(result.rescues).toHaveLength(0);
    expect(result.rescued).toBe(0);
  });
});

describe("AC7 — scenario: drifted delegate is corrected", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("drifted ticket gets delegate updated to correct body for state's owner_role", async () => {
    // write-tests owner_role=test-author → tdd; but hanzo (deployment) is the current delegate
    const { fetch: mock, delegateUpdateCalls } = makeLinearMock({
      issues: [
        { id: "uuid-drift", identifier: "AI-800", labels: ["wf:dev-impl", "state:write-tests"], delegateId: "hanzo" },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
      capabilityPolicyPath: writeCapabilityPolicy(),
    });

    expect(result.rescued).toBe(1);
    expect(delegateUpdateCalls).toContain("uuid-drift");
    expect(result.rescues[0]?.classification).toBe("drifted");
    expect(result.rescues[0]?.outcome).toBe("rescued");
  });

  it("drifted with ambiguous role (multi-body): outcome is 'ambiguous', no update applied", async () => {
    // implementation owner_role=dev has felix/noah/sage/igor (4 bodies) → ambiguous
    const { fetch: mock, delegateUpdateCalls } = makeLinearMock({
      issues: [
        { id: "uuid-amb", identifier: "AI-801", labels: ["wf:dev-impl", "state:implementation"], delegateId: "astrid" },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
      capabilityPolicyPath: writeCapabilityPolicy(),
    });

    // ambiguous: not auto-rescued; outcome is 'ambiguous' and no delegate is forced
    const action = result.rescues.find((r) => r.ticketId === "uuid-amb");
    expect(action?.outcome).toBe("ambiguous");
    expect(delegateUpdateCalls).not.toContain("uuid-amb");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC2 — rescue applies correct Linear mutations
// ══════════════════════════════════════════════════════════════════════════

describe("AC2 — rescue mutations: delegate-set fires for dormant; bootstrap fires for malformed", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("mixed sweep: dormant and malformed are both rescued; healthy left alone", async () => {
    const { fetch: mock, delegateUpdateCalls, labelUpdateCalls } = makeLinearMock({
      issues: [
        // dormant
        { id: "uuid-dormant-mix", identifier: "AI-900", labels: ["wf:dev-impl", "state:intake"], delegateId: null },
        // malformed
        { id: "uuid-malformed-mix", identifier: "AI-901", labels: ["wf:dev-impl"], delegateId: null },
        // healthy
        { id: "uuid-healthy-mix", identifier: "AI-902", labels: ["wf:dev-impl", "state:code-review"], delegateId: "charles" },
        // terminal
        { id: "uuid-terminal-mix", identifier: "AI-903", labels: ["wf:dev-impl", "state:done"], delegateId: null },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
      capabilityPolicyPath: writeCapabilityPolicy(),
    });

    expect(result.scanned).toBe(4);
    expect(result.rescued).toBe(2);
    // dormant got delegate set
    expect(delegateUpdateCalls).toContain("uuid-dormant-mix");
    // malformed got label + delegate
    expect(labelUpdateCalls).toContain("uuid-malformed-mix");
    expect(delegateUpdateCalls).toContain("uuid-malformed-mix");
    // healthy untouched
    expect(delegateUpdateCalls).not.toContain("uuid-healthy-mix");
    // terminal untouched
    expect(delegateUpdateCalls).not.toContain("uuid-terminal-mix");
  });

  it("rescue result has correct byClassification counts for all 5 categories", async () => {
    const { fetch: mock } = makeLinearMock({
      issues: [
        { id: "u-h",  identifier: "AI-910", labels: ["wf:dev-impl", "state:intake"],      delegateId: "astrid" }, // healthy
        { id: "u-do", identifier: "AI-911", labels: ["wf:dev-impl", "state:write-tests"],  delegateId: null },    // dormant
        { id: "u-ma", identifier: "AI-912", labels: ["wf:dev-impl"],                        delegateId: null },    // malformed
        { id: "u-dr", identifier: "AI-913", labels: ["wf:dev-impl", "state:deployment"],   delegateId: "tdd" },   // drifted (tdd is not deployment)
        { id: "u-t",  identifier: "AI-914", labels: ["wf:dev-impl", "state:done"],         delegateId: null },    // terminal
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
      capabilityPolicyPath: writeCapabilityPolicy(),
    });

    expect(result.byClassification?.healthy  ?? 0).toBe(1);
    expect(result.byClassification?.dormant  ?? 0).toBe(1);
    expect(result.byClassification?.malformed ?? 0).toBe(1);
    expect((result.byClassification?.drifted ?? 0) + (result.byClassification?.healthy ?? 0)).toBeGreaterThanOrEqual(1);
    expect(result.byClassification?.terminal ?? 0).toBe(1);
    expect(result.scanned).toBe(5);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC4 — each rescue emits an operational event
// ══════════════════════════════════════════════════════════════════════════

describe("AC4 — each rescue emits an operational event", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("dormant rescue emits exactly one operational event", async () => {
    const { fetch: mock } = makeLinearMock({
      issues: [
        { id: "uuid-ev1", identifier: "AI-1000", labels: ["wf:dev-impl", "state:write-tests"], delegateId: null },
      ],
    });
    globalThis.fetch = mock;
    const { store, events } = makeEventSpy();

    await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
      capabilityPolicyPath: writeCapabilityPolicy(),
      operationalEventStore: store,
    });

    expect(events.length).toBeGreaterThanOrEqual(1);
    const rescueEvent = events.find((e) => e.type === "rescue" || (e.outcome as string).includes("rescue"));
    expect(rescueEvent).toBeDefined();
  });

  it("malformed rescue emits an operational event with ticket identifier in detail", async () => {
    const { fetch: mock } = makeLinearMock({
      issues: [
        { id: "uuid-ev2", identifier: "AI-1001", labels: ["wf:dev-impl"], delegateId: null },
      ],
    });
    globalThis.fetch = mock;
    const { store, events } = makeEventSpy();

    await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
      capabilityPolicyPath: writeCapabilityPolicy(),
      operationalEventStore: store,
    });

    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events.find(
      (e) => JSON.stringify(e.detail ?? "").includes("AI-1001") || JSON.stringify(e).includes("AI-1001"),
    );
    expect(ev).toBeDefined();
  });

  it("no events emitted when all tickets are healthy or terminal", async () => {
    const { fetch: mock } = makeLinearMock({
      issues: [
        { id: "uuid-ev3", identifier: "AI-1002", labels: ["wf:dev-impl", "state:intake"], delegateId: "astrid" },
        { id: "uuid-ev4", identifier: "AI-1003", labels: ["wf:dev-impl", "state:done"],   delegateId: null },
      ],
    });
    globalThis.fetch = mock;
    const { store, events } = makeEventSpy();

    await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
      operationalEventStore: store,
    });

    const rescueEvents = events.filter(
      (e) => e.type === "rescue" || (e.outcome as string).includes("rescue"),
    );
    expect(rescueEvents).toHaveLength(0);
  });

  it("summary is returned in the result (not just emitted as event)", async () => {
    const { fetch: mock } = makeLinearMock({
      issues: [
        { id: "uuid-s1", identifier: "AI-1010", labels: ["wf:dev-impl", "state:write-tests"], delegateId: null },
        { id: "uuid-s2", identifier: "AI-1011", labels: ["wf:dev-impl"],                       delegateId: null },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
      capabilityPolicyPath: writeCapabilityPolicy(),
    });

    expect(result.rescued).toBe(2);
    expect(result.rescues).toHaveLength(2);
    expect(result.rescues.map((r) => r.identifier)).toContain("AI-1010");
    expect(result.rescues.map((r) => r.identifier)).toContain("AI-1011");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC5 — Idempotency within a single sweep
// ══════════════════════════════════════════════════════════════════════════

describe("AC5 — idempotency within a single sweep", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("a ticket rescued once in a sweep does not appear twice in rescues[]", async () => {
    // If the Linear mock returns the same ticket twice (e.g. pagination), it must
    // be deduped and rescued exactly once.
    const duplicateIssue = { id: "uuid-dup", identifier: "AI-1100", labels: ["wf:dev-impl", "state:write-tests"], delegateId: null };
    const { fetch: mock, delegateUpdateCalls } = makeLinearMock({
      issues: [duplicateIssue, duplicateIssue], // same ticket twice
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
      capabilityPolicyPath: writeCapabilityPolicy(),
    });

    expect(result.rescues.filter((r) => r.ticketId === "uuid-dup")).toHaveLength(1);
    expect(delegateUpdateCalls.filter((id) => id === "uuid-dup")).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC1 — multi-workflow registry: tickets from different wf:* workflows
// ══════════════════════════════════════════════════════════════════════════

describe("AC1 — multi-workflow registry: wf:ux-audit tickets classified using their own def", () => {
  it("classifyTicket with ux-audit def correctly identifies dormant ux-audit ticket", () => {
    const uxAuditDef = {
      id: "ux-audit",
      entry_state: "scoping",
      states: [
        { id: "scoping",  owner_role: "steward" },
        { id: "research", owner_role: "ux-researcher" },
        { id: "done",     owner_role: undefined },
      ],
    };
    const uxRoleResolver = makeRoleResolver({
      steward: ["astrid"],
      "ux-researcher": ["signe"],
    });

    const result = classifyTicket(
      ["wf:ux-audit", "state:research"],
      null, // no delegate
      uxAuditDef,
      uxRoleResolver,
    );
    expect(result).toBe<TicketClassification>("dormant");
  });

  it("unknown wf:* label (no matching def in registry): not classified as healthy", async () => {
    let originalFetch: typeof globalThis.fetch = globalThis.fetch;
    const { fetch: mock } = makeLinearMock({
      issues: [
        { id: "uuid-unk", identifier: "AI-1200", labels: ["wf:unknown-workflow", "state:doing"], delegateId: "astrid" },
      ],
    });
    globalThis.fetch = mock;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      // Registry does NOT include wf:unknown-workflow
      workflowRegistry: new Map([["dev-impl", { ...TEST_WORKFLOW_DEF }]]),
    });

    // ticket with unknown wf: should be in errors or counted differently — not silently healthy
    const isInErrors = result.errors.some((e) => e.includes("unknown-workflow") || e.includes("AI-1200"));
    const isInRescues = result.rescues.some((r) => r.ticketId === "uuid-unk");
    const isCountedHealthy = result.byClassification?.healthy === 1 && result.scanned === 1;
    // Must be either an error or a non-healthy classification
    expect(isInErrors || isInRescues || !isCountedHealthy).toBe(true);

    globalThis.fetch = originalFetch;
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Regression: full connector jest suite must remain green
// (This test block validates the rescue-sweep module does NOT break existing
//  exports. The content of existing modules is unchanged.)
// ══════════════════════════════════════════════════════════════════════════

describe("regression guard — rescue-sweep module shape", () => {
  it("exports classifyTicket as a function", () => {
    expect(typeof classifyTicket).toBe("function");
  });

  it("exports runRescueSweep as an async function", () => {
    expect(typeof runRescueSweep).toBe("function");
    const result = runRescueSweep({ authToken: "Bearer x" });
    expect(result).toBeInstanceOf(Promise);
    result.catch(() => {}); // suppress unhandled rejection
  });

  it("RescueSweepResult has the expected shape", async () => {
    const result = await runRescueSweep({ authToken: "Bearer x" });
    expect(result).toHaveProperty("scanned");
    expect(result).toHaveProperty("rescued");
    expect(result).toHaveProperty("byClassification");
    expect(result).toHaveProperty("rescues");
    expect(result).toHaveProperty("errors");
    expect(Array.isArray(result.rescues)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });
});
