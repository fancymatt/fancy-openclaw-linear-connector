import { jest } from "@jest/globals";
import { isLinearIssueActionable } from "./linear-actionable.js";

describe("isLinearIssueActionable", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv, LINEAR_API_KEY: "lin_test_token" };
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("uses a Bearer authorization header for Linear API checks", async () => {
    const fetchMock = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { issue: { state: { name: "Todo", type: "unstarted" } } } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(isLinearIssueActionable("linear-AI-597", "unknown-agent")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer lin_test_token",
        }),
      }),
    );
  });

  it("does not double-prefix an already Bearer-prefixed token", async () => {
    process.env = { ...originalEnv, LINEAR_API_KEY: "Bearer existing_token" };
    const fetchMock = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { issue: { state: { name: "Done", type: "completed" } } } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(isLinearIssueActionable("AI-501", "unknown-agent")).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer existing_token",
        }),
      }),
    );
  });
});
