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
import { recordAppliedState, _resetAppliedStateStore } from "../store/applied-state-store.js";

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

// ── Setup / teardown ──────────────────────────────────────────────────────

let tmpYamlPath: string;
let tmpGuidanceDir: string;
let tmpPolicyPath: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-message-test-"));
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
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.WORKFLOW_GUIDANCE_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
  resetPolicyCache();
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

      // Completed work funnels through Ai for validation (mandatory review hop)
      expect(msg).toContain("linear handoff-work AI-002 Ai");
      // Agents no longer pick domain reviewers themselves
      expect(msg).not.toContain("Charles for code");
      expect(msg).not.toContain("Astrid for product");
      // The old "never hand off to Matt" prohibition is gone
      expect(msg).not.toContain("do NOT hand off to Matt Henry");
      // No "only if you are NOT the implementer" gate on completion
      expect(msg).not.toContain("NOT the implementer");

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

    it("fetch throws → context-unavailable fallback (AI-1708)", async () => {
      globalThis.fetch = async () => {
        throw new Error("network error");
      };

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-007", "Fetch error"), "Bearer tok");

      // AI-1708: transient fetch failures no longer silently fall back to the
      // bare generic message. Instead a context-unavailable fallback is delivered
      // that does NOT contain "Next Steps:" but does include a workflow-context
      // notice and instructs the agent to check its state.
      expect(msg).not.toContain("Next Steps:");
      expect(msg).toContain("Workflow context unavailable");
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

  // ── AI-1534 — read-after-write lag guard via applied-state cache ──────────
  describe("AI-1534 — prefers just-applied state over a stale live read", () => {
    it("AC1: live read still shows old state but cache has new state → names the NEW state's verb", async () => {
      // Live label read lags at the pre-transition state (intake)...
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
      // ...but the connector just applied accept (intake → implementation) and
      // recorded the authoritative destination.
      recordAppliedState("AI-100", "implementation");

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-100", "Lagged read"), "Bearer tok");

      // Message describes the NEW state and lists its verb (submit), never the
      // previous state's verb (accept) that the gate would reject.
      expect(msg).toContain("state: **implementation**");
      expect(msg).toContain("linear submit AI-100");
      expect(msg).not.toContain("linear accept AI-100");
      expect(msg).not.toContain("state: **intake**");
    });

    it("AC2: a redelivery built across a transition reflects the NEW state, not the first build", async () => {
      // The delivery message is always rebuilt at send time (deliver.ts), and
      // the live label read stays stale at `intake` throughout (eventual
      // consistency). Build the message BEFORE the transition is recorded, then
      // record the transition (as applyStateTransition would), then build the
      // coalesced redelivery — it must reflect the new state even though the
      // live read never changed. This is the "coalesced webhooks across a
      // transition" regression: the second (winning) build is correct.
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
      const buildDeliveryMessage = await getbuildDeliveryMessage();

      // First webhook arrives pre-transition: no cache → reflects live read.
      const firstBuild = await buildDeliveryMessage(makeRoute("AI-101", "Pre"), "Bearer tok");
      expect(firstBuild).toContain("state: **intake**");
      expect(firstBuild).toContain("linear accept AI-101");

      // The connector applies accept (intake → implementation) and records it.
      recordAppliedState("AI-101", "implementation");

      // Coalesced redelivery (built at send time, live read STILL stale):
      const route = { ...makeRoute("AI-101", "Coalesced across transition"), coalescedCount: 2 };
      const redelivery = await buildDeliveryMessage(route, "Bearer tok");
      expect(redelivery).toContain("state: **implementation**");
      expect(redelivery).toContain("linear submit AI-101");
      expect(redelivery).not.toContain("linear accept AI-101");
      // Coalescing note still present — the cache guard does not suppress it.
      expect(redelivery).toContain("2 additional event(s)");
    });

    it("no cache entry → falls back to the live read (unchanged behavior)", async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
      // No recordAppliedState call.

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-102", "No cache"), "Bearer tok");

      expect(msg).toContain("state: **intake**");
      expect(msg).toContain("linear accept AI-102");
    });

    it("cache agreeing with live read → identical message, no spurious switch", async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
      recordAppliedState("AI-103", "implementation");

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-103", "Agreeing"), "Bearer tok");

      expect(msg).toContain("state: **implementation**");
      expect(msg).toContain("linear submit AI-103");
    });
  });
});
