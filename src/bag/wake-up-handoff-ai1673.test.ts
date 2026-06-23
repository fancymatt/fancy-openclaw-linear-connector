/**
 * AI-1673: Failing tests for handoff comment visibility in wake-up messages.
 *
 * Root cause: when a state-transition webhook fires, the connector dispatches
 * the next agent immediately — before the prior delegate's handoff comment has
 * landed in Linear. The next agent wakes up without the handoff context.
 *
 * Fix (Option A): bundle the prior delegate's most recent comment into the
 * wake-up message at dispatch time, so even if the comment hasn't landed in
 * Linear yet, the receiving agent sees it in the wake-up payload.
 *
 * AC coverage:
 *   AC1 — wake-up message includes the prior delegate's most recent comment
 *   AC3 — no regression: wake-ups without handoff context are unchanged
 *   AC4 — state transition + comment in same second → dispatched agent sees comment
 *   AC5 — handoff context preserved even if comment has transient delay
 *
 * These tests call buildWakeUpMessage with a HandoffContext third argument.
 * They will fail until the implementation adds HandoffContext support.
 */

import { buildWakeUpMessage } from "./wake-up.js";
import type { HandoffContext } from "./wake-up.js";

// ---------------------------------------------------------------------------
// AC1: wake-up message includes prior delegate's comment when handoff occurred
// ---------------------------------------------------------------------------

describe("buildWakeUpMessage — handoff context (AC1, AI-1673)", () => {
  const handoffCtx: HandoffContext = {
    delegateName: "Astrid",
    comment: "Implementation complete. Watch for X and Y.",
    ageMs: 2000,
  };

  test("includes the prior delegate's comment body in the message", () => {
    const msg = buildWakeUpMessage(["AI-1673"], undefined, handoffCtx);
    expect(msg).toContain("Implementation complete. Watch for X and Y.");
  });

  test("identifies the prior delegate by name", () => {
    const msg = buildWakeUpMessage(["AI-1673"], undefined, handoffCtx);
    expect(msg).toContain("Astrid");
  });

  test("labels the content as coming from the previous delegate", () => {
    const msg = buildWakeUpMessage(["AI-1673"], undefined, handoffCtx);
    expect(msg).toMatch(/previous delegate|prior delegate|Latest from/i);
  });

  test("message still contains the ticket ID and correct consider-work command", () => {
    const msg = buildWakeUpMessage(["AI-1673"], undefined, handoffCtx);
    expect(msg).toContain("AI-1673");
    expect(msg).toContain("linear consider-work AI-1673");
  });

  test("includes handoff context in multi-ticket wake-up as well", () => {
    const ctx: HandoffContext = {
      delegateName: "Astrid",
      comment: "Multi-ticket handoff context.",
      ageMs: 1000,
    };
    const msg = buildWakeUpMessage(["AI-1", "AI-2"], undefined, ctx);
    expect(msg).toContain("Multi-ticket handoff context.");
    expect(msg).toContain("Astrid");
    // Multi-ticket message must still route the agent correctly
    expect(msg).toContain("linear queue --next");
  });

  test("message format matches expected handoff preamble shape", () => {
    const msg = buildWakeUpMessage(["AI-1673"], undefined, handoffCtx);
    // Verify the message contains both name and comment in a readable handoff section.
    // The exact format is up to the implementer, but both must be present and
    // the attribution must be legible.
    expect(msg).toContain("Astrid");
    expect(msg).toContain("Implementation complete. Watch for X and Y.");
    // Should appear before the action directive so the agent reads context first.
    const commentIdx = msg.indexOf("Implementation complete");
    const actionIdx = msg.indexOf("linear consider-work");
    expect(commentIdx).toBeLessThan(actionIdx);
  });
});

// ---------------------------------------------------------------------------
// AC4: state transition + comment in same second → dispatched agent sees comment
// (Reproduces the AI-1658 race: Astrid's comment posted at 02:10:23, TDD's
// dispatch triggered at 02:10:23 — same second, comment not yet visible.)
// ---------------------------------------------------------------------------

describe("buildWakeUpMessage — same-second handoff race (AC4, AI-1673)", () => {
  test("includes comment when ageMs=0 (comment posted at same instant as transition)", () => {
    const ctx: HandoffContext = {
      delegateName: "Astrid",
      comment: "Handoff note posted at same second as transition.",
      ageMs: 0,
    };
    const msg = buildWakeUpMessage(["AI-1658"], undefined, ctx);
    expect(msg).toContain("Handoff note posted at same second as transition.");
  });

  test("includes comment when ageMs is very small (sub-second race window)", () => {
    const ctx: HandoffContext = {
      delegateName: "Astrid",
      comment: "Race-condition handoff: comment posted 200ms after transition.",
      ageMs: 200,
    };
    const msg = buildWakeUpMessage(["AI-1658"], undefined, ctx);
    expect(msg).toContain("Race-condition handoff: comment posted 200ms after transition.");
  });
});

// ---------------------------------------------------------------------------
// AC5: handoff context preserved even if comment posting has transient delay
// (Comment may arrive seconds after the state transition fired.)
// ---------------------------------------------------------------------------

describe("buildWakeUpMessage — transient delay resilience (AC5, AI-1673)", () => {
  test("includes comment posted 5s after transition (ageMs=5000)", () => {
    const ctx: HandoffContext = {
      delegateName: "Astrid",
      comment: "This comment arrived 5s after the transition.",
      ageMs: 5000,
    };
    const msg = buildWakeUpMessage(["AI-1658"], undefined, ctx);
    expect(msg).toContain("This comment arrived 5s after the transition.");
  });

  test("includes comment posted 30s after transition (upper plausible delay window)", () => {
    const ctx: HandoffContext = {
      delegateName: "Astrid",
      comment: "Comment with 30s transient delay still surfaces to next agent.",
      ageMs: 30_000,
    };
    const msg = buildWakeUpMessage(["AI-1658"], undefined, ctx);
    expect(msg).toContain("Comment with 30s transient delay still surfaces to next agent.");
  });
});

// ---------------------------------------------------------------------------
// AC3: no regression — wake-ups without handoff context are unchanged
// Existing tests in wake-up.test.ts still pass; these confirm the boundary.
// ---------------------------------------------------------------------------

describe("buildWakeUpMessage — no handoff context, no regression (AC3, AI-1673)", () => {
  test("omitting handoffContext returns the same single-ticket message as before", () => {
    const msg = buildWakeUpMessage(["AI-1673"]);
    expect(msg).toContain("linear consider-work AI-1673");
    expect(msg).toContain("AI-1673");
  });

  test("null handoffContext returns the standard single-ticket message", () => {
    const msg = buildWakeUpMessage(["AI-1673"], undefined, null);
    expect(msg).toContain("linear consider-work AI-1673");
    expect(msg).not.toContain("previous delegate");
    expect(msg).not.toContain("Latest from");
  });

  test("null handoffContext returns the standard multi-ticket message", () => {
    const msg = buildWakeUpMessage(["AI-1", "AI-2"], undefined, null);
    expect(msg).toContain("linear queue --next");
    expect(msg).not.toContain("previous delegate");
    expect(msg).not.toContain("Latest from");
  });

  test("no handoffContext: message does not include handoff preamble", () => {
    const msg = buildWakeUpMessage(["AI-1673"]);
    expect(msg).not.toMatch(/previous delegate|prior delegate|Latest from/i);
  });

  test("null handoffContext: message length is same as baseline (no padding added)", () => {
    const baseline = buildWakeUpMessage(["AI-1673"]);
    const withNull = buildWakeUpMessage(["AI-1673"], undefined, null);
    expect(withNull).toBe(baseline);
  });
});
