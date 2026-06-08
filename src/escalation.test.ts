/**
 * Unit tests for DELEGATE_UNAVAILABLE escalation module (AI-1428).
 */

import { emitDelegateUnavailable } from "./escalation.js";

// Mock getAccessToken so we don't transitively import agents.ts
// which depends on the missing fancy-openclaw-linear-skill-cli module.
jest.mock("./agents.js", () => ({
  getAccessToken: jest.fn().mockReturnValue(null),
}));

const originalFetch = globalThis.fetch;

function mockFetchSequence(responses: Array<{ ok: boolean; status: number; json?: () => Promise<unknown> }>) {
  let callIndex = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis.fetch as any) = jest.fn().mockImplementation(() => {
    const resp = responses[callIndex++] ?? { ok: false, status: 404, json: () => Promise.resolve({}) };
    return Promise.resolve(resp);
  });
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

describe("emitDelegateUnavailable", () => {
  afterEach(() => {
    restoreFetch();
    jest.restoreAllMocks();
  });

  it("returns commentPosted=true when issue found and comment succeeds", async () => {
    mockFetchSequence([
      // Issue lookup
      { ok: true, status: 200, json: () => Promise.resolve({ data: { issue: { id: "issue-uuid-1" } } }) },
      // Comment post
      { ok: true, status: 200, json: () => Promise.resolve({ data: { commentCreate: { success: true, comment: { id: "comment-uuid-1" } } } }) },
    ]);

    const result = await emitDelegateUnavailable("AI-1428", "igor", "timeout: 60000ms timeout", "Bearer test-token");
    expect(result.commentPosted).toBe(true);
  });

  it("returns commentPosted=false when issue not found", async () => {
    mockFetchSequence([
      { ok: true, status: 200, json: () => Promise.resolve({ data: { issue: null } }) },
    ]);

    const result = await emitDelegateUnavailable("AI-NONEXISTENT", "igor", "unreachable", "Bearer test-token");
    expect(result.commentPosted).toBe(false);
  });

  it("returns commentPosted=false when no auth token", async () => {
    const saved = process.env.LINEAR_OAUTH_TOKEN;
    delete process.env.LINEAR_OAUTH_TOKEN;
    try {
      const result = await emitDelegateUnavailable("AI-1428", "igor", "timeout", undefined);
      expect(result.commentPosted).toBe(false);
    } finally {
      if (saved) process.env.LINEAR_OAUTH_TOKEN = saved;
    }
  });

  it("returns commentPosted=false when comment post fails", async () => {
    mockFetchSequence([
      // Issue lookup succeeds
      { ok: true, status: 200, json: () => Promise.resolve({ data: { issue: { id: "issue-uuid-1" } } }) },
      // Comment post fails
      { ok: true, status: 200, json: () => Promise.resolve({ data: { commentCreate: { success: false } } }) },
    ]);

    const result = await emitDelegateUnavailable("AI-1428", "igor", "error", "Bearer test-token");
    expect(result.commentPosted).toBe(false);
  });
});
