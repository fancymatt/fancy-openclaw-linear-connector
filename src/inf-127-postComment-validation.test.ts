/**
 * INF-127: postComment() swallows failed commentCreate responses, defeating
 * INF-12's fail-close remedy comments.
 *
 * Validates that postComment now checks response.ok, GraphQL errors, and
 * commentCreate.success before returning silently.
 */

import { describe, it, expect, jest } from "@jest/globals";
import { _postCommentForTests, _setLogForTests } from "./workflow-gate.js";

/**
 * Helper: create a mock fetch that returns the given Response.
 */
function mockFetchOnce(response: Response): typeof globalThis.fetch {
  const fn: any = async () => response;
  return fn as typeof globalThis.fetch;
}

describe("postComment response validation (INF-127)", () => {
  let originalFetch: typeof globalThis.fetch;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    consoleErrorSpy.mockRestore();
  });

  it("logs HTTP error on non-ok status (500)", async () => {
    globalThis.fetch = mockFetchOnce(
      new Response("Internal Server Error", { status: 500 }),
    );
    await _postCommentForTests("issue-uuid", "body-text", "Bearer tok");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("workflow-gate: postComment HTTP 500 on issue-uuid"),
    );
  });

  it("logs GraphQL error when response has errors array", async () => {
    globalThis.fetch = mockFetchOnce(
      new Response(
        JSON.stringify({
          errors: [{ message: "Cannot create comment on archived issue" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await _postCommentForTests("issue-uuid", "body-text", "Bearer tok");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("workflow-gate: postComment GraphQL error on issue-uuid"),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot create comment on archived issue"),
    );
  });

  it("logs error when commentCreate.success is not true", async () => {
    globalThis.fetch = mockFetchOnce(
      new Response(
        JSON.stringify({
          data: { commentCreate: { success: false, comment: null } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await _postCommentForTests("issue-uuid", "body-text", "Bearer tok");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("workflow-gate: postComment commentCreate.success !== true on issue-uuid"),
    );
  });

  it("logs nothing (no error) on successful comment", async () => {
    globalThis.fetch = mockFetchOnce(
      new Response(
        JSON.stringify({
          data: { commentCreate: { success: true, comment: { id: "comment-uuid" } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await _postCommentForTests("issue-uuid", "body-text", "Bearer tok");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("logs parse error on unparseable JSON body", async () => {
    globalThis.fetch = mockFetchOnce(
      new Response("not-json-at-all", { status: 200 }),
    );
    await _postCommentForTests("issue-uuid", "body-text", "Bearer tok");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("workflow-gate: postComment unparseable JSON on issue-uuid"),
    );
  });

  it("catches network-level failure and logs warn", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await _postCommentForTests("issue-uuid", "body-text", "Bearer tok");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("workflow-gate: failed to post comment on issue-uuid"),
    );
  });
});
