/**
 * Unit tests for routing-guard module (AI-1428).
 */

import { checkRoleGuard } from "./routing-guard.js";

// Mock getAccessToken so we don't transitively import agents.ts
// which depends on the missing fancy-openclaw-linear-skill-cli module.
jest.mock("./agents.js", () => ({
  getAccessToken: jest.fn().mockReturnValue(null),
}));

// Hard-coded copy of the review-only set for test verification.
// Must be kept in sync with routing-guard.ts REVIEW_ONLY_AGENTS.
const REVIEW_ONLY_FOR_TEST = [
  "charles", "ai", "astrid", "finn", "mckell", "yoshi", "ken", "miki",
  "poe", "kat", "maren", "kenji", "lacey", "scout",
];

describe("checkRoleGuard", () => {
  it("passes through non-workflow tickets (no wf: label)", () => {
    const result = checkRoleGuard("charles", []);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("passes through non-workflow tickets with other labels", () => {
    const result = checkRoleGuard("charles", ["bug", "priority:high"]);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("passes through workflow tickets not in implementation state", () => {
    const result = checkRoleGuard("charles", ["wf:dev-impl", "state:intake"]);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("advisory-warns when implementation-state ticket routed to review-only agent (charles)", () => {
    const result = checkRoleGuard("charles", ["wf:dev-impl", "state:implementation"]);
    // Advisory mode: blocked is false but reason is set
    expect(result.blocked).toBe(false);
    expect(result.reason).toContain("charles");
    expect(result.reason).toContain("review-only");
  });

  it("passes through when implementation-state ticket routed to implementer (igor)", () => {
    const result = checkRoleGuard("igor", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("is case-insensitive for agent ID", () => {
    const result = checkRoleGuard("Charles", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(false);
    expect(result.reason).toContain("review-only");
  });

  it("warns for all review-only agents in implementation state", () => {
    for (const agent of REVIEW_ONLY_FOR_TEST) {
      const result = checkRoleGuard(agent, ["wf:dev-impl", "state:implementation"]);
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain(agent);
    }
  });

  it("passes through for non-review-only agents even in implementation state", () => {
    const result = checkRoleGuard("igor", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("handles mixed-case state labels", () => {
    const result = checkRoleGuard("charles", ["wf:dev-impl", "state:Implementation"]);
    // The regex is case-insensitive
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("passes for code-review state routed to review-only agent", () => {
    // review-only is fine in code-review state — only implementation state is guarded
    const result = checkRoleGuard("charles", ["wf:dev-impl", "state:code-review"]);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });
});
