/**
 * Tests for Phase 3 / B3 — Outbound per-step instruction injection (AI-1354).
 *
 * Verifies:
 * 1. Workflow ticket in state X → delivery message lists X's legal commands + escape.
 * 2. Ad-hoc ticket (no wf:* label) → byte-identical to generic message (uses "Next Steps:").
 * 3. Mention routing → mention message regardless of workflow labels.
 * 4. Fail-open: missing state label / unknown state → falls back to generic.
 *
 * Uses WORKFLOW_DEF_PATH env injection so tests never depend on vault paths.
 * Replaces globalThis.fetch to intercept label resolution calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetWorkflowCache } from "../workflow-gate.js";
import { resetPolicyCache } from "../escalation-gate.js";

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

// ── Helper to build a minimal RouteResult ─────────────────────────────────

function makeRoute(
  identifier: string,
  title: string,
  routingReason: "delegate" | "assignee" | "mention" | "body-mention" = "delegate",
): import("../types.js").RouteResult {
  return {
    agentId: "charles",
    sessionKey: `linear-${identifier}`,
    priority: 0,
    routingReason,
    event: {
      type: "Issue",
      action: "update",
      actor: { id: "u1", name: "Ai", type: "user" },
      data: { identifier, title },
    } as unknown as import("../types.js").RouteResult["event"],
  };
}

// ── Fetch mock helper ─────────────────────────────────────────────────────

function makeLabelFetch(labels: string[]): typeof globalThis.fetch {
  return async (_url, _init) =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            labels: { nodes: labels.map((name) => ({ name })) },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

// ── Minimal capability policy fixture ────────────────────────────────────
// Mirrors the fleet's real policy structure; covers only bodies/roles used
// by TEST_WORKFLOW_YAML (steward/dev/code-review/deployment).

const TEST_CAPABILITY_POLICY_YAML = `
capabilities:
  - id: deploy:execute
    description: Execute deployment operations
    exclusive: true
  - id: repo:read
    description: Read GitHub repos
  - id: repo:write
    description: Push branches, open PRs
  - id: linear:transition
    description: Run Linear semantic CLI commands
  - id: human:escalate
    description: Escalate directly to a human
    exclusive: true
  - id: vault:read
    description: Read the Obsidian vault

containers:
  - id: deployment
    grants: [repo:read, deploy:execute, linear:transition, vault:read]
  - id: dev
    grants: [repo:read, repo:write, linear:transition, vault:read]
  - id: dev-backend
    grants: [repo:read, repo:write, linear:transition, vault:read]
  - id: steward
    grants: [linear:transition, human:escalate, vault:read]

roles:
  - id: dev
    requires: [repo:write]
  - id: code-review
    requires: [repo:read]
    exclusive: true
  - id: deployment
    requires: [deploy:execute]
    exclusive: true
  - id: steward
    requires: [human:escalate]

bodies:
  - id: felix
    persona: person
    container: dev
    fills_roles: [dev]
  - id: noah
    persona: person
    container: dev
    fills_roles: [dev]
  - id: sage
    persona: person
    container: dev
    fills_roles: [dev]
  - id: igor
    persona: person
    container: dev-backend
    fills_roles: [dev]
  - id: charles
    persona: person
    container: dev
    fills_roles: [code-review]
  - id: hanzo
    persona: functionary
    container: deployment
    fills_roles: [deployment]
  - id: astrid
    persona: person
    container: steward
    fills_roles: [steward]
`;

// ── Setup / teardown ──────────────────────────────────────────────────────

let tmpYamlPath: string;
let tmpPolicyPath: string;
let tmpGuidanceDir: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-message-test-"));
  tmpYamlPath = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(tmpYamlPath, TEST_WORKFLOW_YAML, "utf8");
  tmpPolicyPath = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(tmpPolicyPath, TEST_CAPABILITY_POLICY_YAML, "utf8");
  tmpGuidanceDir = path.join(dir, "guidance");
  fs.mkdirSync(path.join(tmpGuidanceDir, "dev-impl"), { recursive: true });
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  process.env.WORKFLOW_DEF_PATH = tmpYamlPath;
  process.env.WORKFLOW_GUIDANCE_DIR = tmpGuidanceDir;
  process.env.CAPABILITY_POLICY_PATH = tmpPolicyPath;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.WORKFLOW_GUIDANCE_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
  // Remove any guidance files written by tests
  for (const f of fs.readdirSync(path.join(tmpGuidanceDir, "dev-impl"))) {
    fs.rmSync(path.join(tmpGuidanceDir, "dev-impl", f));
  }
});

// ── Import under test ─────────────────────────────────────────────────────

async function getbuildDeliveryMessage() {
  const mod = await import("./build-message.js");
  return mod.buildDeliveryMessage;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("B3 — outbound per-step instruction injection", () => {
  describe("workflow ticket — per-state legal command listing", () => {
    const states: Array<{
      state: string;
      expectedCommands: string[];
      notExpected?: string[];
    }> = [
      {
        state: "intake",
        expectedCommands: ["linear accept AI-001", "linear demote AI-001"],
        notExpected: ["linear submit AI-001", "linear approve AI-001"],
      },
      {
        state: "implementation",
        expectedCommands: ["linear submit AI-001"],
        notExpected: ["linear accept AI-001", "linear approve AI-001"],
      },
      {
        state: "code-review",
        expectedCommands: [
          "linear approve AI-001",
          'linear request-changes AI-001 <felix|noah|sage|igor> --comment "<feedback>"',
        ],
        notExpected: ["linear submit AI-001", "linear deploy AI-001"],
      },
      {
        state: "deployment",
        expectedCommands: [
          "linear deploy AI-001",
          'linear reject AI-001 <felix|noah|sage|igor> --comment "<feedback>"',
        ],
        notExpected: ["linear approve AI-001", "linear submit AI-001"],
      },
    ];

    test.each(states)(
      "state '$state' lists correct commands and escape",
      async ({ state, expectedCommands, notExpected }) => {
        globalThis.fetch = makeLabelFetch([`wf:dev-impl`, `state:${state}`]);

        const buildDeliveryMessage = await getbuildDeliveryMessage();
        const msg = await buildDeliveryMessage(makeRoute("AI-001", "Test ticket"), "Bearer tok");

        // Workflow header present
        expect(msg).toContain("[dev-impl]");
        expect(msg).toContain(`state: **${state}**`);

        // Legal commands present
        for (const cmd of expectedCommands) {
          expect(msg).toContain(cmd);
        }

        // Escape always present (§4.4)
        expect(msg).toContain("linear escape AI-001");
        expect(msg).toContain("→ escape");

        // Generic "Next Steps:" block absent
        expect(msg).not.toContain("Next Steps:");

        // Illegal commands absent
        if (notExpected) {
          for (const cmd of notExpected) {
            expect(msg).not.toContain(cmd);
          }
        }
      },
    );
  });

  describe("ad-hoc ticket — generic message unchanged", () => {
    it("no wf:* label → generic delegation message", async () => {
      globalThis.fetch = makeLabelFetch(["priority:high"]); // no wf:* label

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-002", "Ad-hoc task"), "Bearer tok");

      // Generic message structure present
      expect(msg).toContain("Next Steps:");
      expect(msg).toContain("linear consider-work AI-002");
      expect(msg).toContain("linear begin-work AI-002");

      // Workflow-specific content absent
      expect(msg).not.toContain("[dev-impl]");
      expect(msg).not.toContain("state: **");
    });

    it("empty label list → generic delegation message", async () => {
      globalThis.fetch = makeLabelFetch([]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-010", "No labels"), "Bearer tok");

      expect(msg).toContain("Next Steps:");
      expect(msg).not.toContain("[dev-impl]");
    });

    it("no authToken → generic delegation message without any fetch call", async () => {
      let fetchCalled = false;
      globalThis.fetch = async (..._args) => {
        fetchCalled = true;
        throw new Error("should not be called");
      };

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-003", "No-token task"), undefined);

      expect(msg).toContain("Next Steps:");
      expect(fetchCalled).toBe(false);
    });
  });

  describe("mention routing — mention message regardless of workflow", () => {
    it("mention event → mention message, no workflow injection", async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(
        makeRoute("AI-004", "Mention test", "mention"),
        "Bearer tok",
      );

      expect(msg).toContain("You were mentioned on AI-004");
      expect(msg).toContain("linear observe-issue AI-004");
      expect(msg).not.toContain("[dev-impl]");
      expect(msg).not.toContain("Next Steps:");
    });
  });

  describe("fail-open cases → generic message", () => {
    it("no state:* label → generic", async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl"]); // missing state:*

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-005", "Missing state"), "Bearer tok");

      expect(msg).toContain("Next Steps:");
      expect(msg).not.toContain("[dev-impl]");
    });

    it("unknown state → generic", async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:nonexistent"]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-006", "Unknown state"), "Bearer tok");

      expect(msg).toContain("Next Steps:");
      expect(msg).not.toContain("[dev-impl]");
    });

    it("fetch throws → generic", async () => {
      globalThis.fetch = async () => {
        throw new Error("network error");
      };

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-007", "Fetch error"), "Bearer tok");

      expect(msg).toContain("Next Steps:");
    });
  });

  describe("C5 — step-scoped guidance injection (AI-1381)", () => {
    it("approved guidance for current state → injected into message", async () => {
      fs.writeFileSync(
        path.join(tmpGuidanceDir, "dev-impl", "implementation.md"),
        "Always include tests for new parser paths.\n",
        "utf8",
      );
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-020", "Guidance test"), "Bearer tok");

      expect(msg).toContain("Step guidance");
      expect(msg).toContain("Always include tests for new parser paths.");
      // Legal commands still present
      expect(msg).toContain("linear submit AI-020");
    });

    it("no guidance file for current state → message byte-identical to pre-C5 output", async () => {
      // No file written — guidance dir for this step is empty
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-021", "No guidance"), "Bearer tok");

      expect(msg).not.toContain("Step guidance");
      // Core content still intact
      expect(msg).toContain("[dev-impl]");
      expect(msg).toContain("state: **implementation**");
      expect(msg).toContain("linear submit AI-021");
    });

    it("guidance for a different step does NOT appear at current step", async () => {
      fs.writeFileSync(
        path.join(tmpGuidanceDir, "dev-impl", "code-review.md"),
        "Verify edge-case coverage before approving.\n",
        "utf8",
      );
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-022", "Wrong step"), "Bearer tok");

      expect(msg).not.toContain("Step guidance");
      expect(msg).not.toContain("Verify edge-case coverage");
    });
  });

  describe("coalescence note appended on both paths", () => {
    it("workflow ticket with coalescedCount → workflow message + coalescing note", async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const route = { ...makeRoute("AI-008", "Coalesced"), coalescedCount: 3 };
      const msg = await buildDeliveryMessage(route, "Bearer tok");

      expect(msg).toContain("[dev-impl]");
      expect(msg).toContain("3 additional event(s)");
    });

    it("ad-hoc ticket with coalescedCount → generic message + coalescing note", async () => {
      globalThis.fetch = makeLabelFetch([]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const route = { ...makeRoute("AI-009", "Ad-hoc coalesced"), coalescedCount: 2 };
      const msg = await buildDeliveryMessage(route, "Bearer tok");

      expect(msg).toContain("Next Steps:");
      expect(msg).toContain("2 additional event(s)");
    });
  });
});
