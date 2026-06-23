/**
 * AI-1669: Failing tests — workflow context in connector wake-up delivery message.
 *
 * AC coverage:
 *   AC1 — Delivery messages for governed workflow tickets include the current state
 *          name and the legal verb set for that state.
 *   AC2 — Non-governed (ad-hoc) ticket wake-ups are unchanged.
 *   AC3 — The verb list is derived from the workflow YAML, not hardcoded.
 *   AC4 — (This file is the test required by AC4.)
 *
 * These tests are written BEFORE the implementation exists; they must all be red
 * on the current codebase and green after implementation.
 */

import { describe, test, expect } from "@jest/globals";
import * as WakeUp from "./wake-up.js";
import type { WorkflowDef } from "../workflow-gate.js";

// ── Types expected after implementation ───────────────────────────────────────

/** Context shape that buildWakeUpMessage must accept for governed tickets (AC1). */
interface WorkflowTicketContext {
  workflowId: string;
  state: string;
  legalVerbs: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Bridge to the (not-yet-exported) getLegalVerbsForState (AC3).
 * Throws with a clear message if the function is not exported — each test that
 * calls this will fail until AC3 is implemented.
 */
function getLegalVerbsForState(def: WorkflowDef, stateId: string): string[] {
  const fn = (WakeUp as Record<string, unknown>)["getLegalVerbsForState"];
  if (typeof fn !== "function") {
    throw new Error(
      "getLegalVerbsForState is not exported from wake-up.ts — implement AC3 to export it."
    );
  }
  return (fn as (d: WorkflowDef, s: string) => string[])(def, stateId);
}

/**
 * Call buildWakeUpMessage with a WorkflowTicketContext as the governed-ticket
 * context argument. The current implementation does not accept this shape, so
 * each AC1 test will fail (TypeError or assertion failure) until the new
 * signature is added.
 */
function buildGoverned(ticketIds: string[], context: WorkflowTicketContext): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (WakeUp.buildWakeUpMessage as any)(ticketIds, context);
}

// ── Shared fixture: minimal WorkflowDef for AC3 derivation tests ──────────────

const DEV_IMPL_MINI: WorkflowDef = {
  id: "dev-impl",
  version: 8,
  break_glass: { command: "escape" },
  states: [
    {
      id: "write-tests",
      owner_role: "test-author",
      kind: "normal",
      native_state: "todo",
      transitions: [{ command: "tests-ready", to: "implementation", assign: { mode: "required" } }],
    },
    {
      id: "implementation",
      owner_role: "dev",
      kind: "normal",
      native_state: "todo",
      transitions: [
        { command: "submit", to: "code-review", assign: { mode: "required", constraint: "not-implementer" } },
      ],
    },
    {
      id: "code-review",
      owner_role: "code-review",
      kind: "normal",
      native_state: "todo",
      transitions: [
        { command: "approve", to: "deployment", assign: { mode: "auto" } },
        { command: "request-changes", to: "implementation" },
      ],
    },
    { id: "done",   kind: "terminal", native_state: "done" },
    { id: "escape", kind: "terminal", native_state: "invalid" },
  ],
};

// ── AC1: Governed ticket wake-up includes state name and legal verb set ────────

describe("AC1: governed ticket — wake-up message includes workflow context", () => {
  const CONTEXT: WorkflowTicketContext = {
    workflowId: "dev-impl",
    state: "write-tests",
    legalVerbs: ["tests-ready", "escape"],
  };

  test("includes the workflow id", () => {
    const msg = buildGoverned(["AI-1669"], CONTEXT);
    expect(msg).toContain("dev-impl");
  });

  test("includes the current state name", () => {
    const msg = buildGoverned(["AI-1669"], CONTEXT);
    expect(msg).toContain("write-tests");
  });

  test("includes each legal verb", () => {
    const msg = buildGoverned(["AI-1669"], CONTEXT);
    expect(msg).toContain("tests-ready");
    expect(msg).toContain("escape");
  });

  test("includes the consider-work instruction so the agent knows how to receive full instructions", () => {
    const msg = buildGoverned(["AI-1669"], CONTEXT);
    expect(msg).toContain("linear consider-work AI-1669");
  });

  test("mentions that this is a governed workflow step", () => {
    const msg = buildGoverned(["AI-1669"], CONTEXT);
    expect(msg.toLowerCase()).toContain("governed");
  });

  test("includes the ticket identifier", () => {
    const msg = buildGoverned(["AI-1669"], CONTEXT);
    expect(msg).toContain("AI-1669");
  });

  test("different state context yields different state name and verb list", () => {
    const implContext: WorkflowTicketContext = {
      workflowId: "dev-impl",
      state: "implementation",
      legalVerbs: ["submit", "escape"],
    };
    const msg = buildGoverned(["AI-1670"], implContext);
    expect(msg).toContain("implementation");
    expect(msg).toContain("submit");
    expect(msg).not.toContain("tests-ready");
  });

  test("strips the linear- session-key prefix before embedding the ticket id", () => {
    const msg = buildGoverned(["linear-AI-1669"], CONTEXT);
    expect(msg).toContain("AI-1669");
    expect(msg).not.toContain("linear-AI-1669");
  });
});

// ── AC2: Non-governed (ad-hoc) ticket wake-ups are unchanged ─────────────────

describe("AC2: non-governed (ad-hoc) ticket wake-ups are unchanged", () => {
  test("single ad-hoc ticket: uses consider-work, no governed mention", () => {
    const msg = WakeUp.buildWakeUpMessage(["AI-832"]);
    expect(msg).toContain("linear consider-work AI-832");
    expect(msg.toLowerCase()).not.toContain("governed");
  });

  test("multi-ticket ad-hoc wake-up: uses queue --next, no governed mention", () => {
    const msg = WakeUp.buildWakeUpMessage(["AI-832", "AI-833"]);
    expect(msg).toContain("linear queue --next");
    expect(msg.toLowerCase()).not.toContain("governed");
  });

  test("ad-hoc single ticket: does not include workflow or state context markers", () => {
    const msg = WakeUp.buildWakeUpMessage(["ILL-100"]);
    expect(msg).not.toMatch(/workflow:/i);
    expect(msg).not.toMatch(/state:/i);
  });
});

// ── AC3: Verb list is derived from workflow YAML structure, not hardcoded ─────

describe("AC3: getLegalVerbsForState derives verbs from WorkflowDef", () => {
  test("getLegalVerbsForState is exported from wake-up.ts", () => {
    expect(
      typeof (WakeUp as Record<string, unknown>)["getLegalVerbsForState"]
    ).toBe("function");
  });

  test("write-tests state: returns tests-ready and escape", () => {
    const verbs = getLegalVerbsForState(DEV_IMPL_MINI, "write-tests");
    expect(verbs).toContain("tests-ready");
    expect(verbs).toContain("escape");
  });

  test("write-tests state: does not return verbs from other states", () => {
    const verbs = getLegalVerbsForState(DEV_IMPL_MINI, "write-tests");
    expect(verbs).not.toContain("submit");
    expect(verbs).not.toContain("approve");
    expect(verbs).not.toContain("request-changes");
  });

  test("implementation state: returns submit and escape", () => {
    const verbs = getLegalVerbsForState(DEV_IMPL_MINI, "implementation");
    expect(verbs).toContain("submit");
    expect(verbs).toContain("escape");
    expect(verbs).not.toContain("tests-ready");
  });

  test("code-review state: returns approve, request-changes, and escape", () => {
    const verbs = getLegalVerbsForState(DEV_IMPL_MINI, "code-review");
    expect(verbs).toContain("approve");
    expect(verbs).toContain("request-changes");
    expect(verbs).toContain("escape");
  });

  test("custom workflow with novel verbs: returns those verbs, not a hardcoded list", () => {
    const customDef: WorkflowDef = {
      id: "custom-wf",
      version: 1,
      break_glass: { command: "bail-out" },
      states: [
        {
          id: "alpha",
          owner_role: "dev",
          kind: "normal",
          native_state: "todo",
          transitions: [
            { command: "frobnicate", to: "beta" },
            { command: "quux-override", to: "gamma" },
          ],
        },
        { id: "beta",  kind: "terminal", native_state: "done" },
        { id: "gamma", kind: "terminal", native_state: "invalid" },
      ],
    };
    const verbs = getLegalVerbsForState(customDef, "alpha");
    expect(verbs).toContain("frobnicate");
    expect(verbs).toContain("quux-override");
    expect(verbs).toContain("bail-out");
    expect(verbs).not.toContain("escape");    // break_glass is "bail-out" here
    expect(verbs).not.toContain("tests-ready");
    expect(verbs).not.toContain("submit");
  });

  test("terminal state with no transitions: returns only the break_glass verb", () => {
    const verbs = getLegalVerbsForState(DEV_IMPL_MINI, "done");
    expect(verbs).toContain("escape");
    expect(verbs).toHaveLength(1);
  });

  test("unknown state id: returns only the break_glass verb as a safe fallback", () => {
    const verbs = getLegalVerbsForState(DEV_IMPL_MINI, "nonexistent-state");
    expect(verbs).toContain("escape");
  });
});
