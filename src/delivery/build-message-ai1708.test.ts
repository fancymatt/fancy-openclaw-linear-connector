/**
 * AI-1708 — Connector: delivery must not silently downgrade to generic message
 * on label-fetch failure.
 *
 * ACs:
 * 1. When label fetch fails due to a transient error (network, 401, 5xx), the
 *    delivery either retries or queues for retry — it does NOT silently deliver
 *    a generic message.
 * 2. If generic fallback is used as a last resort, a WARN log is emitted at the
 *    dispatch site with the failure reason.
 * 3. Agent receives sufficient context to identify the current workflow step
 *    before acting.
 * 4. Regression test: mock label-fetch failure and assert no silent generic
 *    delivery.
 *
 * These tests are written RED against the current implementation which silently
 * downgrades. The implementation must make them pass.
 *
 * Test strategy:
 * - AC1/AC4: Mock fetch to simulate transient failures (network throw, 401, 500).
 *   Assert that buildDeliveryMessage / buildWorkflowAwareDeliveryMessage /
 *   sendWakeUpSignal do NOT produce a generic/thin message without either
 *   retrying or logging a warning.
 * - AC2: Spy on the logger and assert a WARN-level log is emitted with the
 *   failure reason when fallback occurs.
 * - AC3: When the delivery succeeds (non-failing fetch), assert the message
 *   contains the workflow state identifier.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jest } from "@jest/globals";
import { resetWorkflowCache } from "../workflow-gate.js";
import { resetPolicyCache } from "../escalation-gate.js";
import { _resetAppliedStateStore } from "../store/applied-state-store.js";

// ── Test workflow YAML ─────────────────────────────────────────────────────

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 3
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  to: escape

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
      - command: demote
        to: __ad_hoc__

  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: code-review

  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    sla: 24h
    transitions:
      - command: approve
        to: deployment
      - command: request-changes
        to: implementation
        feedback:
          required: true
          category_enum: [missing-tests, style, scope-creep, correctness, ac-mismatch]

  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: todo
    transitions:
      - command: deploy
        to: done
        requires_capability: deploy:execute
      - command: reject
        to: implementation
        feedback:
          required: true
          category_enum: [missing-tests, style, scope-creep, correctness, ac-mismatch]

  - id: done
    kind: terminal
    native_state: done

  - id: escape
    kind: terminal
    native_state: invalid
`;

// ── Test capability policy YAML ───────────────────────────────────────────

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
  - id: deploy:execute
  - id: repo:read

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]
  - id: code-review
    grants: [linear:transition, repo:read]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: main-agent
    grants: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: code-review
    fills_roles: [code-review]
  - id: felix
    container: dev
    fills_roles: [dev]
  - id: noah
    container: dev
    fills_roles: [dev]
  - id: sage
    container: dev
    fills_roles: [dev]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: ai
    openclaw_agent: main
    container: main-agent
    fills_roles: []
`;

// ── Helpers ───────────────────────────────────────────────────────────────

function makeRoute(
  identifier: string,
  title: string,
  routingReason: "delegate" | "assignee" | "mention" | "body-mention" = "delegate",
): import("../types.js").RouteResult {
  return {
    agentId: "tdd",
    sessionKey: `linear-${identifier}`,
    priority: 0,
    routingReason,
    event: {
      type: "Issue",
      action: "update",
      actor: { id: "u1", name: "Astrid", type: "user" },
      data: { identifier, title },
    } as unknown as import("../types.js").RouteResult["event"],
  };
}

/** Mock fetch that returns a successful label response with the given labels. */
function makeLabelFetch(labels: string[]): typeof globalThis.fetch {
  return async (_url, _init) =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            title: "Test ticket",
            labels: { nodes: labels.map((name) => ({ name })) },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

/** Mock fetch that throws a network error. */
function makeNetworkErrorFetch(): typeof globalThis.fetch {
  return async (_url, _init) => {
    throw new Error("network error: ECONNRESET");
  };
}

/** Mock fetch that returns a 401 Unauthorized. */
function make401Fetch(): typeof globalThis.fetch {
  return async (_url, _init) =>
    new Response(
      JSON.stringify({ errors: [{ message: "Unauthorized" }] }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
}

/** Mock fetch that returns a 500 server error. */
function make500Fetch(): typeof globalThis.fetch {
  return async (_url, _init) =>
    new Response(
      JSON.stringify({ errors: [{ message: "Internal server error" }] }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
}

// ── Setup / Teardown ──────────────────────────────────────────────────────

let tmpYamlPath: string;
let tmpGuidanceDir: string;
let tmpPolicyPath: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1708-test-"));
  tmpYamlPath = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(tmpYamlPath, TEST_WORKFLOW_YAML, "utf8");
  tmpGuidanceDir = path.join(dir, "guidance");
  fs.mkdirSync(path.join(tmpGuidanceDir, "dev-impl"), { recursive: true });
  tmpPolicyPath = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(tmpPolicyPath, TEST_POLICY_YAML, "utf8");
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  _resetAppliedStateStore();
  process.env.WORKFLOW_DEF_PATH = tmpYamlPath;
  process.env.WORKFLOW_GUIDANCE_DIR = tmpGuidanceDir;
  process.env.CAPABILITY_POLICY_PATH = tmpPolicyPath;
  // AI-1708 AC2: The connector logger reads LOG_LEVEL at module-import time and
  // suppresses warn-level output when LOG_LEVEL=error (as CI sets). The AC2
  // tests assert on warn-level log output, so force a permissive level and
  // reset modules to ensure the logger re-initialises with it.
  process.env.LOG_LEVEL = "debug";
  jest.resetModules();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.WORKFLOW_GUIDANCE_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.LOG_LEVEL;
  resetPolicyCache();
  for (const f of fs.readdirSync(path.join(tmpGuidanceDir, "dev-impl"))) {
    fs.rmSync(path.join(tmpGuidanceDir, "dev-impl", f));
  }
});

// ── Dynamic imports (after env setup) ─────────────────────────────────────

async function importBuildMessage() {
  return await import("./build-message.js");
}

async function importWakeUp() {
  return await import("../bag/wake-up.js");
}

// ═══════════════════════════════════════════════════════════════════════════
// AC4 + AC1: Label-fetch failure must not silently produce a generic message
// ═══════════════════════════════════════════════════════════════════════════

describe("AI-1708 AC1/AC4 — transient label-fetch failures are not silently downgraded", () => {
  const transientFailures: Array<{ name: string; makeFetch: () => typeof globalThis.fetch; reason: string }> = [
    { name: "network error (throw)", makeFetch: makeNetworkErrorFetch, reason: "ECONNRESET" },
    { name: "401 Unauthorized", makeFetch: make401Fetch, reason: "401" },
    { name: "500 Internal Server Error", makeFetch: make500Fetch, reason: "500" },
  ];

  // Run each transient failure scenario for the event-driven delivery path.
  for (const { name: scenarioName, makeFetch, reason } of transientFailures) {
    describe(`event-driven path (buildDeliveryMessage) — ${scenarioName}`, () => {
      beforeEach(() => {
        globalThis.fetch = makeFetch();
      });

      it("AC1: does NOT silently return a generic 'Next Steps:' message for a workflow ticket", async () => {
        const { buildDeliveryMessage } = await importBuildMessage();
        const msg = await buildDeliveryMessage(
          makeRoute("AI-1701", "Workflow ticket with transient fetch failure"),
          "Bearer valid-token",
        );

        // The generic message is identifiable by "Next Steps:" — if the
        // implementation silently downgrades, this assertion fails.
        // AC1 requires that the delivery either retry or queue for retry
        // rather than deliver this generic message.
        expect(msg).not.toContain("Next Steps:");
      });

      it("AC2: emits a WARN log with the failure reason at the dispatch site", async () => {
        const warnSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        const { buildDeliveryMessage } = await importBuildMessage();
        await buildDeliveryMessage(
          makeRoute("AI-1702", "Workflow ticket — log check"),
          "Bearer valid-token",
        );

        // AC2: the implementation must log a warning at the dispatch/build-message
        // site (not just inside fetchWorkflowLabels) when falling back to generic.
        // The connector logger writes to console.error. Check for a warn-level
        // message that mentions the fallback and includes context about the
        // failure (e.g., reason, label fetch, generic, fallback).
        const allCalls = warnSpy.mock.calls.map((c) => String(c));
        const hasFallbackWarn = allCalls.some(
          (s) =>
            s.toLowerCase().includes("fallback") ||
            s.toLowerCase().includes("generic") ||
            s.toLowerCase().includes("label fetch") ||
            s.toLowerCase().includes("workflow delivery"),
        );
        expect(hasFallbackWarn).toBe(true);
        warnSpy.mockRestore();
      });
    });
  }

  for (const { name: scenarioName, makeFetch } of transientFailures) {
    describe(`wake-up path (buildWorkflowAwareDeliveryMessage) — ${scenarioName}`, () => {
      beforeEach(() => {
        globalThis.fetch = makeFetch();
      });

      it("AC1: does NOT silently return null (causing thin template) for a workflow ticket", async () => {
        const { buildWorkflowAwareDeliveryMessage } = await importBuildMessage();
        const result = await buildWorkflowAwareDeliveryMessage(
          "AI-1703",
          "Bearer valid-token",
        );

        // If this returns null, sendWakeUpSignal falls through to the thin
        // "You have 1 pending ticket" template — the silent downgrade.
        // AC1 requires retry or queue, not a silent null.
        //
        // The implementation must either:
        //   - return a rich message (after successful retry), or
        //   - throw an error so the caller can queue for retry.
        expect(result).not.toBeNull();
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2: WARN log at the dispatch site when generic fallback is used
// ═══════════════════════════════════════════════════════════════════════════

describe("AI-1708 AC2 — WARN log emitted on generic fallback with failure reason", () => {
  it("if generic fallback IS used as last resort, a WARN log includes the failure reason", async () => {
    // Capture console output / logger calls.
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    globalThis.fetch = makeNetworkErrorFetch();

    const { buildDeliveryMessage } = await importBuildMessage();
    await buildDeliveryMessage(
      makeRoute("AI-1704", "Fallback log test"),
      "Bearer valid-token",
    );

    // The implementation must emit a WARN-level log at the dispatch site
    // (build-message.ts or deliver.ts) that includes the failure reason.
    //
    // We check console output because the connector's logger may write to
    // stdout/stderr. The key signal is a message containing both:
    //   - an indication of fallback/generic delivery
    //   - the failure reason (e.g., "network error", "ECONNRESET", "401")
    //
    // This test will fail RED until the implementation adds the dispatch-site
    // warn log.
    const allCalls = [
      ...warnSpy.mock.calls.map((c) => String(c)),
      ...errorSpy.mock.calls.map((c) => String(c)),
      ...logSpy.mock.calls.map((c) => String(c)),
    ];

    const hasFallbackWarn = allCalls.some(
      (s) =>
        s.toLowerCase().includes("fallback") ||
        s.toLowerCase().includes("generic") ||
        s.toLowerCase().includes("workflow delivery"),
    );
    const hasFailureReason = allCalls.some(
      (s) =>
        s.includes("ECONNRESET") ||
        s.includes("network error") ||
        s.includes("401") ||
        s.includes("500") ||
        s.toLowerCase().includes("label fetch"),
    );

    // At least one of these must be true after implementation.
    // Both must be present to satisfy AC2.
    expect(hasFallbackWarn).toBe(true);
    expect(hasFailureReason).toBe(true);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3: Agent receives sufficient context to identify the current workflow step
// ═══════════════════════════════════════════════════════════════════════════

describe("AI-1708 AC3 — agent can identify the current workflow step before acting", () => {
  it("successful workflow delivery includes the workflow id and current state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

    const { buildDeliveryMessage } = await importBuildMessage();
    const msg = await buildDeliveryMessage(
      makeRoute("AI-1705", "Workflow ticket — context check"),
      "Bearer valid-token",
    );

    // AC3: the message must contain enough context for the agent to identify
    // the current workflow step.
    expect(msg).toContain("[dev-impl]");
    expect(msg).toContain("state: **implementation**");
    // Legal commands for this state are listed so the agent knows what to do.
    expect(msg).toContain("linear submit AI-1705");
  });

  it("wake-up delivery with successful fetch includes the workflow state, not a thin template", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

    const { buildWorkflowAwareDeliveryMessage } = await importBuildMessage();
    const result = await buildWorkflowAwareDeliveryMessage(
      "AI-1706",
      "Bearer valid-token",
    );

    expect(result).not.toBeNull();
    expect(result!).toContain("[dev-impl]");
    expect(result!).toContain("state: **implementation**");
    // The thin template says "Run `linear consider-work`" — the rich message
    // must not be that thin template.
    expect(result).not.toContain("You have 1 pending ticket");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Regression guard: the OLD silent-downgrade behavior must not return
// ═══════════════════════════════════════════════════════════════════════════

describe("AI-1708 AC4 — regression: mock label-fetch failure must not silently deliver generic", () => {
  it("REGRESSION: network error on a workflow ticket does not produce generic message", async () => {
    // This is the exact scenario from the bug report (AI-1707):
    // TDD's session received a generic "You have 1 pending ticket" message
    // because the label fetch failed silently during a 401 token window.
    globalThis.fetch = makeNetworkErrorFetch();

    const { buildDeliveryMessage } = await importBuildMessage();
    const msg = await buildDeliveryMessage(
      makeRoute("AI-1707", "Connector: delivery must not silently downgrade"),
      "Bearer expired-or-transient-token",
    );

    // The generic message that caused the AI-1707 incident:
    // "You have 1 pending ticket: AI-1707. Run `linear consider-work AI-1707` to begin."
    // This is the EXACT pattern that must NOT be silently produced.
    expect(msg).not.toContain("You have 1 pending ticket");
    expect(msg).not.toContain("Next Steps:");
    expect(msg).not.toContain("linear consider-work AI-1707");
  });

  it("REGRESSION: 401 error on wake-up path does not produce thin template via sendWakeUpSignal", async () => {
    globalThis.fetch = make401Fetch();

    const { buildWorkflowAwareDeliveryMessage } = await importBuildMessage();
    const result = await buildWorkflowAwareDeliveryMessage(
      "AI-1707",
      "Bearer expired-token",
    );

    // Must not silently return null (which causes the thin template).
    // Either retries and succeeds, or throws so the caller can queue.
    expect(result).not.toBeNull();
    expect(result).not.toContain("You have 1 pending ticket");
  });
});
