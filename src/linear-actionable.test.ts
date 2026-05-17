import { jest } from "@jest/globals";
import { isBlockedByOpenIssue, isLinearIssueActionable, isLinearIssueStillRoutedToAgent, isParkedIssueState } from "./linear-actionable.js";

const IGOR_LINEAR_USER_ID = "3d6a19fb-037c-4543-a5ca-6219d014a14f";

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

  it("treats Backlog tickets as non-actionable for wake-up prompts", async () => {
    const fetchMock = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { issue: { state: { name: "Backlog", type: "backlog" } } } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(isLinearIssueActionable("AI-942", "igor")).resolves.toBe(false);
  });

  it("recognizes Backlog as parked state", () => {
    expect(isParkedIssueState({ name: "Backlog", type: "backlog" })).toBe(true);
    expect(isParkedIssueState({ name: "Todo", type: "unstarted" })).toBe(false);
  });

  it("treats tickets blocked by unfinished prerequisites as non-actionable", async () => {
    const fetchMock = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            id: "issue-982", identifier: "AI-982",
            state: { name: "Todo", type: "unstarted" },
            relations: {
              nodes: [{
                type: "blocks",
                issue: { id: "issue-980", identifier: "AI-980", state: { name: "Doing", type: "started" } },
                relatedIssue: { id: "issue-982", identifier: "AI-982", state: { name: "Todo", type: "unstarted" } },
              }],
            },
          },
        },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(isLinearIssueActionable("AI-982", "unknown-agent")).resolves.toBe(false);
  });

  it("allows tickets whose blockers are terminal", async () => {
    const fetchMock = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            id: "issue-982", identifier: "AI-982",
            state: { name: "Todo", type: "unstarted" },
            relations: {
              nodes: [{
                type: "blocks",
                issue: { id: "issue-980", identifier: "AI-980", state: { name: "Done", type: "completed" } },
                relatedIssue: { id: "issue-982", identifier: "AI-982", state: { name: "Todo", type: "unstarted" } },
              }],
            },
          },
        },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(isLinearIssueActionable("AI-982", "unknown-agent")).resolves.toBe(true);
  });

  it("suppresses dispatch for delegate-routed blocked tickets", async () => {
    const fetchMock = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            id: "issue-982", identifier: "AI-982",
            delegate: { id: IGOR_LINEAR_USER_ID, name: "Igor" },
            state: { name: "Todo", type: "unstarted" },
            relations: {
              nodes: [{
                type: "blocks",
                issue: { id: "issue-980", identifier: "AI-980", state: { name: "Doing", type: "started" } },
                relatedIssue: { id: "issue-982", identifier: "AI-982", state: { name: "Todo", type: "unstarted" } },
              }],
            },
          },
        },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(isLinearIssueStillRoutedToAgent("linear-AI-982", "igor", "delegate")).resolves.toBe(false);
  });

  it("keeps mention routing independent from blocker checks", async () => {
    const fetchMock = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(isLinearIssueStillRoutedToAgent("linear-AI-982", "igor", "mention")).resolves.toBe(true);
    await expect(isLinearIssueStillRoutedToAgent("linear-AI-982", "igor", "body-mention")).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("correctly identifies the blocked side of a blocks relation", () => {
    const blockedIssue = {
      id: "issue-982", identifier: "AI-982",
      state: { name: "Todo", type: "unstarted" },
      relations: {
        nodes: [{
          type: "blocks",
          issue: { id: "issue-980", identifier: "AI-980", state: { name: "Doing", type: "started" } },
          relatedIssue: { id: "issue-982", identifier: "AI-982", state: { name: "Todo", type: "unstarted" } },
        }],
      },
    };
    const blockingIssue = {
      id: "issue-980", identifier: "AI-980",
      state: { name: "Doing", type: "started" },
      relations: { nodes: [blockedIssue.relations.nodes[0]] },
    };
    expect(isBlockedByOpenIssue(blockedIssue)).toBe(true);
    expect(isBlockedByOpenIssue(blockingIssue)).toBe(false);
  });
});
