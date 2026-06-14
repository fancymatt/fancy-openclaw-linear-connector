/**
 * Failing tests for AI-1594 — governed state:* label regression guard.
 *
 * AC3: A stale webhook carrying an older state:* label set must NOT cause the
 *      connector to treat the ticket as regressed (no backwards routing/delegate
 *      correction off stale labels).
 *
 * AC4: Add an operational warning when a ticket is observed transitioning to an
 *      *earlier* workflow state without a corresponding B2 apply (corruption canary).
 *
 * All tests in this file are written against a module (`./state-regression.js`)
 * that does not yet exist. They must fail red until the implementation is added.
 * Each test maps to exactly one AC per the naming convention.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  rankStateInWorkflow,
  isStateBackwards,
  detectStateRegression,
  StateRegressionResult,
  createStateHighWaterMarkTracker,
  StateHighWaterMarkTracker,
} from "./state-regression.js";
import type { WorkflowDef } from "./workflow-gate.js";

// ── Minimal dev-impl fixture (ordered path: intake → write-tests →
//    implementation → code-review → deployment → ac-validate → done) ────────

const DEV_IMPL_DEF: WorkflowDef = {
  id: "dev-impl",
  entry_state: "intake",
  states: [
    {
      id: "intake",
      owner_role: "steward",
      transitions: [{ command: "accept", to: "write-tests" }],
    },
    {
      id: "write-tests",
      owner_role: "test-author",
      transitions: [{ command: "tests-ready", to: "implementation" }],
    },
    {
      id: "implementation",
      owner_role: "dev",
      transitions: [{ command: "submit", to: "code-review" }],
    },
    {
      id: "code-review",
      owner_role: "code-review",
      transitions: [
        { command: "approve", to: "deployment" },
        { command: "request-changes", to: "implementation" },
      ],
    },
    {
      id: "deployment",
      owner_role: "deployment",
      transitions: [
        { command: "deploy", to: "ac-validate" },
        { command: "reject", to: "implementation" },
      ],
    },
    {
      id: "ac-validate",
      owner_role: "steward",
      transitions: [
        { command: "validated", to: "done" },
        { command: "ac-fail", to: "implementation" },
      ],
    },
    {
      id: "done",
      kind: "terminal",
      transitions: [],
    },
    {
      id: "escape",
      kind: "terminal",
      transitions: [],
    },
  ],
};

// ── AC3: State ranking ────────────────────────────────────────────────────────

describe("rankStateInWorkflow (AC3 — state ordering)", () => {
  it("ranks intake before write-tests (first forward step)", () => {
    const intake = rankStateInWorkflow("intake", DEV_IMPL_DEF);
    const writeTests = rankStateInWorkflow("write-tests", DEV_IMPL_DEF);
    expect(intake).toBeLessThan(writeTests);
  });

  it("ranks write-tests before implementation", () => {
    const writeTests = rankStateInWorkflow("write-tests", DEV_IMPL_DEF);
    const impl = rankStateInWorkflow("implementation", DEV_IMPL_DEF);
    expect(writeTests).toBeLessThan(impl);
  });

  it("ranks implementation before code-review", () => {
    const impl = rankStateInWorkflow("implementation", DEV_IMPL_DEF);
    const review = rankStateInWorkflow("code-review", DEV_IMPL_DEF);
    expect(impl).toBeLessThan(review);
  });

  it("ranks code-review before deployment — the regression pair from AI-1594 incident", () => {
    const review = rankStateInWorkflow("code-review", DEV_IMPL_DEF);
    const deployment = rankStateInWorkflow("deployment", DEV_IMPL_DEF);
    expect(review).toBeLessThan(deployment);
  });

  it("ranks deployment before ac-validate", () => {
    const deployment = rankStateInWorkflow("deployment", DEV_IMPL_DEF);
    const acValidate = rankStateInWorkflow("ac-validate", DEV_IMPL_DEF);
    expect(deployment).toBeLessThan(acValidate);
  });

  it("ranks ac-validate before done (terminal)", () => {
    const acValidate = rankStateInWorkflow("ac-validate", DEV_IMPL_DEF);
    const done = rankStateInWorkflow("done", DEV_IMPL_DEF);
    expect(acValidate).toBeLessThan(done);
  });

  it("returns null for an unknown state", () => {
    const rank = rankStateInWorkflow("nonexistent-state", DEV_IMPL_DEF);
    expect(rank).toBeNull();
  });

  it("returns null for escape (break-glass terminal — unordered)", () => {
    // escape is reachable from any state and should not be ranked in the linear forward path
    const rank = rankStateInWorkflow("escape", DEV_IMPL_DEF);
    expect(rank).toBeNull();
  });
});

// ── AC3: isStateBackwards ─────────────────────────────────────────────────────

describe("isStateBackwards (AC3 — stale-label detection)", () => {
  it("returns true when observed state precedes last known state (code-review < deployment)", () => {
    // This is the exact regression pair observed in the AI-1594 incident.
    const backwards = isStateBackwards("code-review", "deployment", DEV_IMPL_DEF);
    expect(backwards).toBe(true);
  });

  it("returns true when observed state is two hops behind last known (implementation < deployment)", () => {
    const backwards = isStateBackwards("implementation", "deployment", DEV_IMPL_DEF);
    expect(backwards).toBe(true);
  });

  it("returns true when observed state is at intake and last known is done", () => {
    const backwards = isStateBackwards("intake", "done", DEV_IMPL_DEF);
    expect(backwards).toBe(true);
  });

  it("returns false when observed state equals last known state (same snapshot)", () => {
    const backwards = isStateBackwards("deployment", "deployment", DEV_IMPL_DEF);
    expect(backwards).toBe(false);
  });

  it("returns false when observed state is ahead of last known state (forward motion)", () => {
    const backwards = isStateBackwards("deployment", "code-review", DEV_IMPL_DEF);
    expect(backwards).toBe(false);
  });

  it("returns false when either state is unknown (fail open)", () => {
    expect(isStateBackwards("nonexistent", "deployment", DEV_IMPL_DEF)).toBe(false);
    expect(isStateBackwards("deployment", "nonexistent", DEV_IMPL_DEF)).toBe(false);
    expect(isStateBackwards("nonexistent", "nonexistent", DEV_IMPL_DEF)).toBe(false);
  });
});

// ── AC4: detectStateRegression ────────────────────────────────────────────────

describe("detectStateRegression (AC4 — corruption canary)", () => {
  it("returns no regression when labels are consistent with last known state", () => {
    const result = detectStateRegression(
      "AI-1566",
      ["wf:dev-impl", "state:deployment"],
      "deployment",
      DEV_IMPL_DEF,
    );
    expect(result.isRegression).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it("returns no regression when observed state is ahead of last known state (forward motion)", () => {
    const result = detectStateRegression(
      "AI-1566",
      ["wf:dev-impl", "state:deployment"],
      "code-review",
      DEV_IMPL_DEF,
    );
    expect(result.isRegression).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it("returns regression with warning for the exact AI-1594 incident pattern", () => {
    // Ticket advanced to deployment via B2. Stale webhook arrives with code-review labels.
    const result = detectStateRegression(
      "AI-1566",
      ["wf:dev-impl", "state:code-review"],
      "deployment",        // last known state recorded after B2 apply
      DEV_IMPL_DEF,
    );
    expect(result.isRegression).toBe(true);
    expect(result.observedState).toBe("code-review");
    expect(result.lastKnownState).toBe("deployment");
  });

  it("includes the ticket ID in the warning message", () => {
    const result = detectStateRegression(
      "AI-1566",
      ["wf:dev-impl", "state:code-review"],
      "deployment",
      DEV_IMPL_DEF,
    );
    expect(result.isRegression).toBe(true);
    expect(result.warning).toMatch(/AI-1566/);
  });

  it("includes both states (observed and expected) in the warning message", () => {
    const result = detectStateRegression(
      "AI-1566",
      ["wf:dev-impl", "state:code-review"],
      "deployment",
      DEV_IMPL_DEF,
    );
    expect(result.warning).toMatch(/code-review/);
    expect(result.warning).toMatch(/deployment/);
  });

  it("returns no regression when lastKnownState is null (ticket freshly seen, no basis for comparison)", () => {
    const result = detectStateRegression(
      "AI-NEW",
      ["wf:dev-impl", "state:code-review"],
      null,
      DEV_IMPL_DEF,
    );
    expect(result.isRegression).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it("returns no regression for ad-hoc tickets (no wf:* label)", () => {
    const result = detectStateRegression(
      "AI-9999",
      ["priority:high"],  // no wf:* label
      "code-review",
      DEV_IMPL_DEF,
    );
    expect(result.isRegression).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it("returns no regression when labels carry no state:* label (enrollment-gap ticket)", () => {
    const result = detectStateRegression(
      "AI-1566",
      ["wf:dev-impl"],    // wf: present but no state:*
      "deployment",
      DEV_IMPL_DEF,
    );
    expect(result.isRegression).toBe(false);
  });
});

// ── AC3: StateHighWaterMarkTracker ────────────────────────────────────────────
// The tracker is what allows the webhook handler to compare fetchWorkflowLabels
// results against the last B2-confirmed state so a stale snapshot cannot trigger
// backwards routing/delegate correction.

describe("StateHighWaterMarkTracker (AC3 — per-ticket monotonic state tracking)", () => {
  let tracker: StateHighWaterMarkTracker;

  beforeEach(() => {
    tracker = createStateHighWaterMarkTracker();
  });

  it("returns null for a ticket never seen before", () => {
    expect(tracker.getLastKnownState("AI-1566")).toBeNull();
  });

  it("records and retrieves the last known state for a ticket", () => {
    tracker.advance("AI-1566", "code-review");
    expect(tracker.getLastKnownState("AI-1566")).toBe("code-review");
  });

  it("advances to a later state and returns the new state", () => {
    tracker.advance("AI-1566", "code-review");
    tracker.advance("AI-1566", "deployment");
    expect(tracker.getLastKnownState("AI-1566")).toBe("deployment");
  });

  it("refuses to regress: a backwards advance does NOT update the stored state", () => {
    tracker.advance("AI-1566", "deployment");
    // B2 already took the ticket to deployment; a stale snapshot must not regress it
    tracker.advance("AI-1566", "code-review");
    expect(tracker.getLastKnownState("AI-1566")).toBe("deployment");
  });

  it("is isolated per ticket — different tickets are tracked independently", () => {
    tracker.advance("AI-1566", "deployment");
    tracker.advance("AI-9999", "code-review");
    expect(tracker.getLastKnownState("AI-1566")).toBe("deployment");
    expect(tracker.getLastKnownState("AI-9999")).toBe("code-review");
  });

  it("returns true from advance() when a regression is attempted (AC4 signal)", () => {
    tracker.advance("AI-1566", "deployment");
    const wasRegression = tracker.advance("AI-1566", "code-review");
    expect(wasRegression).toBe(true);
  });

  it("returns false from advance() on a normal forward transition", () => {
    tracker.advance("AI-1566", "code-review");
    const wasRegression = tracker.advance("AI-1566", "deployment");
    expect(wasRegression).toBe(false);
  });

  it("returns false from advance() when the ticket is freshly seen (no prior state)", () => {
    const wasRegression = tracker.advance("AI-NEW", "deployment");
    expect(wasRegression).toBe(false);
  });

  it("tracks multiple tickets concurrently without interference", () => {
    tracker.advance("AI-1", "implementation");
    tracker.advance("AI-2", "code-review");
    tracker.advance("AI-3", "deployment");

    tracker.advance("AI-1", "code-review");   // forward
    tracker.advance("AI-2", "implementation"); // attempted regression (rejected)
    tracker.advance("AI-3", "ac-validate");    // forward

    expect(tracker.getLastKnownState("AI-1")).toBe("code-review");
    expect(tracker.getLastKnownState("AI-2")).toBe("code-review");   // regression rejected
    expect(tracker.getLastKnownState("AI-3")).toBe("ac-validate");
  });
});

// ── AC3+AC4: Integration — stale fetchWorkflowLabels must not trigger
//    delegate correction ─────────────────────────────────────────────────────
// These tests verify the composition: given a tracker that knows the ticket is
// at `deployment`, when detectStateRegression sees code-review labels (stale),
// it must signal a regression so the caller (webhook) skips the role-guard
// correction, and the warning is emitted for AC4.

describe("composition: tracker + detectStateRegression (AC3 + AC4)", () => {
  let tracker: StateHighWaterMarkTracker;

  beforeEach(() => {
    tracker = createStateHighWaterMarkTracker();
  });

  it("correctly identifies the AI-1594 incident pattern end-to-end", () => {
    // B2 applied: ticket moved to deployment.
    tracker.advance("AI-1566", "deployment");

    // Stale webhook arrives with code-review labels (as observed at 15:08:51Z).
    const staleLabels = ["wf:dev-impl", "state:code-review"];
    const lastKnown = tracker.getLastKnownState("AI-1566");
    const result = detectStateRegression("AI-1566", staleLabels, lastKnown, DEV_IMPL_DEF);

    // Must detect regression — no delegate correction should run.
    expect(result.isRegression).toBe(true);
    expect(result.observedState).toBe("code-review");
    expect(result.lastKnownState).toBe("deployment");
    expect(result.warning).toBeDefined();
  });

  it("does NOT flag a regression when the stale check arrives before B2 advanced the tracker", () => {
    // Ticket is freshly delegated — tracker has no prior observation yet.
    // (The connector hasn't seen the B2 apply event yet either.)
    const freshLabels = ["wf:dev-impl", "state:code-review"];
    const lastKnown = tracker.getLastKnownState("AI-FRESH");  // null
    const result = detectStateRegression("AI-FRESH", freshLabels, lastKnown, DEV_IMPL_DEF);

    expect(result.isRegression).toBe(false);
  });

  it("a forward webhook after a regression attempt does NOT get suppressed", () => {
    // Setup: ticket at deployment; stale snapshot regressed tracker to code-review (rejected).
    tracker.advance("AI-1566", "deployment");
    tracker.advance("AI-1566", "code-review"); // attempted regression → rejected; tracker stays at deployment

    // Now a fresh webhook arrives with the correct labels.
    const correctLabels = ["wf:dev-impl", "state:deployment"];
    const lastKnown = tracker.getLastKnownState("AI-1566");
    const result = detectStateRegression("AI-1566", correctLabels, lastKnown, DEV_IMPL_DEF);

    expect(result.isRegression).toBe(false);
  });
});
