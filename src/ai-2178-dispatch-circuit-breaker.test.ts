/**
 * AI-2178: Dispatch circuit breaker — stop re-waking a delegate on a ticket
 * whose workflow state hasn't moved after N wakes.
 *
 * Tests for both features:
 *   Feature 1: Per-ticket circuit breaker (trips after N consecutive no-change wakes)
 *   Feature 2: Comment-fed re-wake suppression (pre-wake heuristic)
 */

import {
  recordDispatch,
  checkBreaker,
  resetBreaker,
  checkCommentFedSuppressionForTicket,
  getCircuitBreakerHealth,
  getAllBreakerStates,
  resetCircuitBreakerForTest,
} from "./dispatch-circuit-breaker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TICKET = "linear-AI-2178-EXAMPLE";

/** Build a minimal event-like object for checkCommentFedSuppressionForTicket. */
function commentEvent(authorName: string): { type: string; actor: { name: string } } {
  return {
    type: "Comment",
    actor: { name: authorName },
  };
}

function issueEvent(): { type: string } {
  return { type: "Issue" };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetCircuitBreakerForTest();
});

// ---------------------------------------------------------------------------
// Feature 1: Circuit breaker
// ---------------------------------------------------------------------------

describe("Feature 1: per-ticket circuit breaker", () => {
  test("first dispatch seeds state with counter=0", () => {
    const state = recordDispatch(TICKET, "review");
    expect(state.lastStateLabel).toBe("review");
    expect(state.wakeCount).toBe(0);
    expect(state.tripped).toBe(false);

    const breaker = checkBreaker(TICKET);
    expect(breaker.blocked).toBe(false);
  });

  test("state unchanged increments counter", () => {
    // First dispatch
    recordDispatch(TICKET, "review");
    // Second dispatch, same state → increment
    const state = recordDispatch(TICKET, "review");
    expect(state.wakeCount).toBe(1);
    expect(state.tripped).toBe(false);
  });

  test("state changed resets counter", () => {
    recordDispatch(TICKET, "review");
    recordDispatch(TICKET, "wip"); // state changed → reset
    const state = recordDispatch(TICKET, "wip"); // same again → increment from 0
    expect(state.wakeCount).toBe(1); // went 0→1 because the second dispatch was new state reset
  });

  test("state changed between two different labels resets", () => {
    recordDispatch(TICKET, "review");
    const state = recordDispatch(TICKET, "approved");
    expect(state.wakeCount).toBe(0); // state changed → reset
    expect(state.lastStateLabel).toBe("approved");
  });

  test("null state labels work correctly", () => {
    // No state label present
    recordDispatch(TICKET, null);
    let state = recordDispatch(TICKET, null);
    expect(state.wakeCount).toBe(1);

    // Transition from null to a real label resets
    state = recordDispatch(TICKET, "review");
    expect(state.wakeCount).toBe(0);
  });

  test("trips after 3 consecutive no-change wakes (default)", () => {
    // Wake 1: seed
    recordDispatch(TICKET, "stuck");
    // Wake 2: same state → 1
    recordDispatch(TICKET, "stuck");
    // Wake 3: same state → 2
    recordDispatch(TICKET, "stuck");

    // Not tripped yet at count=2 (0-indexed first wake, then +1 each repeat)
    // Actually: first dispatch sets count=0. Second dispatch (same state) → count=1.
    // Third dispatch (same state) → count=2.
    let state = recordDispatch(TICKET, "stuck");
    expect(state.wakeCount).toBe(3);
    expect(state.tripped).toBe(true);
    expect(state.trippedAt).not.toBeNull();
  });

  test("trips at exactly 3 wakes", () => {
    // First: seed
    recordDispatch(TICKET, "stuck"); // count=0
    // Second: same state → count=1
    recordDispatch(TICKET, "stuck"); // count=1
    // Third: same state → count=2
    recordDispatch(TICKET, "stuck"); // count=2, NOT tripped

    let breaker = checkBreaker(TICKET);
    expect(breaker.blocked).toBe(false);

    // Fourth: same state → count=3, TRIPPED
    recordDispatch(TICKET, "stuck"); // count=3

    breaker = checkBreaker(TICKET);
    expect(breaker.blocked).toBe(true);
    expect(breaker.state!.wakeCount).toBe(3);
  });

  test("checkBreaker returns blocked after trip", () => {
    // Trip the breaker
    for (let i = 0; i < 4; i++) {
      recordDispatch(TICKET, "stuck");
    }

    const result = checkBreaker(TICKET);
    expect(result.blocked).toBe(true);
    expect(result.state).toBeDefined();
    expect(result.state!.tripped).toBe(true);
  });

  test("state advance resets and unblocks", () => {
    // Trip the breaker
    for (let i = 0; i < 4; i++) {
      recordDispatch(TICKET, "stuck");
    }
    expect(checkBreaker(TICKET).blocked).toBe(true);

    // State advances → resets
    const state = recordDispatch(TICKET, "progressing");
    expect(state.tripped).toBe(false);
    expect(state.wakeCount).toBe(0);
    expect(checkBreaker(TICKET).blocked).toBe(false);
  });

  test("explicit reset clears the breaker", () => {
    // Trip
    for (let i = 0; i < 4; i++) {
      recordDispatch(TICKET, "stuck");
    }
    expect(checkBreaker(TICKET).blocked).toBe(true);

    // Reset
    const hadState = resetBreaker(TICKET);
    expect(hadState).toBe(true);
    expect(checkBreaker(TICKET).blocked).toBe(false);

    // Reset on untracked ticket returns false
    expect(resetBreaker("linear-UNKNOWN")).toBe(false);
  });

  test("getCircuitBreakerHealth reports correct counts", () => {
    expect(getCircuitBreakerHealth().trackedTickets).toBe(0);
    expect(getCircuitBreakerHealth().trippedCount).toBe(0);

    recordDispatch(TICKET, "a");
    recordDispatch("linear-B", "b");

    expect(getCircuitBreakerHealth().trackedTickets).toBe(2);
    expect(getCircuitBreakerHealth().trippedCount).toBe(0);

    // Trip TICKET
    for (let i = 0; i < 4; i++) {
      recordDispatch(TICKET, "stuck");
    }

    const health = getCircuitBreakerHealth();
    expect(health.active).toBe(true);
    expect(health.trippedCount).toBe(1);
    expect(health.config.maxWakes).toBe(3);
  });

  test("getAllBreakerStates returns deep clones", () => {
    recordDispatch(TICKET, "test");
    const states = getAllBreakerStates();
    expect(states[TICKET]).toBeDefined();
    expect(states[TICKET].lastStateLabel).toBe("test");

    // Mutation should not affect internal state
    states[TICKET].lastStateLabel = "mutated";
    const reRead = getAllBreakerStates();
    expect(reRead[TICKET].lastStateLabel).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// Feature 2: Comment-fed re-wake suppression
// ---------------------------------------------------------------------------

describe("Feature 2: comment-fed re-wake suppression", () => {
  test("non-comment events are not suppressed", () => {
    const event = issueEvent();
    const result = checkCommentFedSuppressionForTicket(TICKET, event, "review", "igor");
    expect(result.suppressed).toBe(false);
  });

  test("comment by non-delegate is not suppressed", () => {
    // Seed the breaker state with a dispatch
    recordDispatch(TICKET, "review");

    const event = commentEvent("SomeOtherGuy");
    const result = checkCommentFedSuppressionForTicket(
      TICKET, event, "review", "igor",
    );
    expect(result.suppressed).toBe(false);
  });

  test("comment by delegate with same state is suppressed", () => {
    recordDispatch(TICKET, "review");

    const event = commentEvent("igor");
    const result = checkCommentFedSuppressionForTicket(
      TICKET, event, "review", "igor",
    );
    expect(result.suppressed).toBe(true);
    expect(result.reason).toContain("state unchanged");
  });

  test("comment by delegate but state changed is NOT suppressed (real progress)", () => {
    recordDispatch(TICKET, "review");

    // State advanced since last dispatch
    const event = commentEvent("igor");
    const result = checkCommentFedSuppressionForTicket(
      TICKET, event, "wip", "igor",
    );
    expect(result.suppressed).toBe(false);
  });

  test("comment by delegate with no prior dispatch is not suppressed", () => {
    // No prior recordDispatch call
    const event = commentEvent("igor");
    const result = checkCommentFedSuppressionForTicket(
      TICKET, event, "review", "igor",
    );
    expect(result.suppressed).toBe(false);
  });

  test("case-insensitive author name matching", () => {
    recordDispatch(TICKET, "review");

    // Author name with parens/title (as Linear app user names often have)
    const event = commentEvent("Igor (Back End Dev)");
    const result = checkCommentFedSuppressionForTicket(
      TICKET, event, "review", "igor",
    );
    expect(result.suppressed).toBe(true);
  });

  test("empty/null author name is not suppressed", () => {
    recordDispatch(TICKET, "review");

    const event = { type: "Comment" as const, actor: null };
    const result = checkCommentFedSuppressionForTicket(
      TICKET, event, "review", "igor",
    );
    expect(result.suppressed).toBe(false);
  });

  test("comment suppression does NOT increment breaker counter", () => {
    // The integration test pattern: comment-fed suppression returns before
    // recordDispatch is called, so the counter stays where it was.
    recordDispatch(TICKET, "review"); // count=0

    // Comment by delegate, state same — would be suppressed in dispatchRoute
    // before recordDispatch runs. Simulate that: don't call recordDispatch.
    const event = commentEvent("igor");
    const result = checkCommentFedSuppressionForTicket(
      TICKET, event, "review", "igor",
    );
    expect(result.suppressed).toBe(true);

    // Counter hasn't moved
    const state = recordDispatch(TICKET, "review"); // this would be the next non-suppressed wake
    expect(state.wakeCount).toBe(1); // still just 1 increment from the first repeat
  });
});
