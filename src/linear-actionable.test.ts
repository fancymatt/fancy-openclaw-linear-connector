import { jest } from "@jest/globals";
import { checkLinearIssueRouting, isBlockedByOpenIssue, isHumanLinearUser, isLinearIssueActionable, isLinearIssueStillRoutedToAgent, isParkedIssueState } from "./linear-actionable.js";

const IGOR_LINEAR_USER_ID = "3d6a19fb-037c-4543-a5ca-6219d014a14f";
const MATT_LINEAR_USER_ID = "0f37f4e2-9f9c-4a9a-bb7a-1f0f4e2c9a11";

/** Linear payload shape for AI-2230: To Do, delegate cleared, parked on a human. */
function humanBlockedIssue(identifier = "AI-2230") {
  return {
    id: `issue-${identifier}`,
    identifier,
    delegate: null,
    assignee: { id: MATT_LINEAR_USER_ID, name: "Matt Henry", app: false },
    state: { name: "To Do", type: "unstarted" },
    relations: { nodes: [] },
  };
}

function okFetch(issue: unknown) {
  return jest
    .fn<(...args: Parameters<typeof fetch>) => Promise<any>>()
    .mockResolvedValue({ ok: true, json: async () => ({ data: { issue } }) });
}

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

  it("treats Backlog tickets as parked and thus non-actionable (AI-2246)", async () => {
    const fetchMock = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { issue: { state: { name: "Backlog", type: "backlog" } } } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(isLinearIssueActionable("AI-942", "igor")).resolves.toBe(false);
  });

  it("treats Backlog as a parked state (AI-2246 Defect B fix)", () => {
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

  it("keeps mention routing independent from the delegate-ownership check", async () => {
    // A mention on a live ticket with no delegate is still a legitimate wake —
    // someone explicitly pinged the agent. Post-AI-2295 the issue IS fetched
    // (the liveness gate applies to every reason), but the ownership gate is
    // still skipped, so a delegate-less ticket stays actionable for a mention.
    const fetchMock = okFetch({
      id: "issue-982",
      identifier: "AI-982",
      delegate: null,
      assignee: null,
      state: { name: "Todo", type: "unstarted" },
      relations: { nodes: [] },
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(isLinearIssueStillRoutedToAgent("linear-AI-982", "igor", "mention")).resolves.toBe(true);
    await expect(isLinearIssueStillRoutedToAgent("linear-AI-982", "igor", "body-mention")).resolves.toBe(true);
  });

  it("drops delegate-routed event when ticket has no delegate (AI-1306: handed-back guard)", async () => {
    // Ticket was handed back — delegate is null. This should be dropped regardless of
    // whether the agent's linearUserId is configured (fixes the missing-linearUserId short-circuit).
    const fetchMock = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            id: "issue-500", identifier: "POD-29",
            delegate: null,   // handed back — no delegate
            assignee: null,
            state: { name: "Todo", type: "unstarted" },
            relations: { nodes: [] },
          },
        },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    // Should drop even when agent has no linearUserId configured
    await expect(isLinearIssueStillRoutedToAgent("linear-POD-29", "unknown-agent", "delegate")).resolves.toBe(false);
  });

  it("drops assignee-routed event when ticket has no assignee (AI-1306: handed-back guard)", async () => {
    const fetchMock = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            id: "issue-501", identifier: "POD-30",
            delegate: null,
            assignee: null,   // unassigned
            state: { name: "Todo", type: "unstarted" },
            relations: { nodes: [] },
          },
        },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(isLinearIssueStillRoutedToAgent("linear-POD-30", "unknown-agent", "assignee")).resolves.toBe(false);
  });

  it("allows delegate-routed event when ticket has a delegate but linearUserId is missing", async () => {
    // Issue has a delegate set; agent's linearUserId is unknown — allow through (can't verify which agent)
    const fetchMock = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            id: "issue-502", identifier: "AI-999",
            delegate: { id: "some-other-agent-uuid", name: "SomeAgent" },
            assignee: null,
            state: { name: "Todo", type: "unstarted" },
            relations: { nodes: [] },
          },
        },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    // No LINEAR_API_KEY means tokenForAgent returns undefined and we return true early.
    // With a token set, we proceed and return true (has delegate, can't verify identity).
    process.env.LINEAR_API_KEY = "lin_test_token";
    await expect(isLinearIssueStillRoutedToAgent("linear-AI-999", "unknown-agent", "delegate")).resolves.toBe(true);
  });

  // ── AI-2295: liveness gate applies to every routing reason; human-blocked
  // prune applies to roster-fanout reasons only. ───────────────────────────

  it("(a) prunes a department-prefix route onto a delegate-less, human-assigned ticket", async () => {
    // The AI-2230 shape: To Do, delegate cleared, assignee = Matt. Human-blocked
    // work, not unrouted departmental work — no agent should be woken.
    const fetchMock = okFetch(humanBlockedIssue());
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await checkLinearIssueRouting("linear-AI-2230", "igor", "department-prefix");
    expect(result).toEqual({ actionable: false, failOpen: false });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("(a) prunes a steward-escalation route onto a delegate-less, human-assigned ticket", async () => {
    global.fetch = okFetch(humanBlockedIssue("AI-2231")) as unknown as typeof fetch;
    await expect(
      isLinearIssueStillRoutedToAgent("linear-AI-2231", "astrid", "steward-escalation"),
    ).resolves.toBe(false);
  });

  it("(b) prunes a department-prefix route onto a terminal ticket", async () => {
    global.fetch = okFetch({
      id: "issue-900", identifier: "AI-900",
      delegate: null, assignee: null,
      state: { name: "Done", type: "completed" },
      relations: { nodes: [] },
    }) as unknown as typeof fetch;

    await expect(
      isLinearIssueStillRoutedToAgent("linear-AI-900", "igor", "department-prefix"),
    ).resolves.toBe(false);
  });

  it("(b) prunes a mention onto a terminal ticket — a stale mention is not a wake", async () => {
    global.fetch = okFetch({
      id: "issue-901", identifier: "AI-901",
      delegate: null, assignee: null,
      state: { name: "Canceled", type: "canceled" },
      relations: { nodes: [] },
    }) as unknown as typeof fetch;

    await expect(isLinearIssueStillRoutedToAgent("linear-AI-901", "igor", "mention")).resolves.toBe(false);
  });

  it("(b) surfaces terminalNotFound for a mention on a phantom ticket", async () => {
    // Pre-AI-2295 the mention path never fetched, so terminalNotFound was always
    // undefined and a phantom mention sailed through the fetchability gate.
    global.fetch = okFetch(null) as unknown as typeof fetch;

    const result = await checkLinearIssueRouting("linear-AI-9999", "igor", "mention");
    expect(result).toEqual({ actionable: false, failOpen: false, terminalNotFound: true });
  });

  it("(c) still wakes on a genuine mention on a delegate-less, human-assigned ticket", async () => {
    // Same ticket shape as (a). A mention is an explicit ping and must NOT be
    // swallowed by the human-blocked prune — conflating these would silently
    // drop real mention dispatches.
    global.fetch = okFetch(humanBlockedIssue("AI-2232")) as unknown as typeof fetch;

    await expect(isLinearIssueStillRoutedToAgent("linear-AI-2232", "igor", "mention")).resolves.toBe(true);
    await expect(isLinearIssueStillRoutedToAgent("linear-AI-2232", "igor", "body-mention")).resolves.toBe(true);
  });

  it("(d) fails open on a transient fetch failure for every routing reason", async () => {
    const reasons = ["delegate", "assignee", "mention", "body-mention", "department-prefix", "steward-escalation"] as const;

    // HTTP error
    global.fetch = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>()
      .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }) as unknown as typeof fetch;
    for (const reason of reasons) {
      await expect(checkLinearIssueRouting("linear-AI-2230", "igor", reason))
        .resolves.toEqual({ actionable: true, failOpen: true });
    }

    // GraphQL errors
    global.fetch = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>()
      .mockResolvedValue({ ok: true, json: async () => ({ errors: [{ message: "rate limited" }] }) }) as unknown as typeof fetch;
    for (const reason of reasons) {
      await expect(checkLinearIssueRouting("linear-AI-2230", "igor", reason))
        .resolves.toEqual({ actionable: true, failOpen: true });
    }

    // Network throw
    global.fetch = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>()
      .mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;
    for (const reason of reasons) {
      await expect(checkLinearIssueRouting("linear-AI-2230", "igor", reason))
        .resolves.toEqual({ actionable: true, failOpen: true });
    }
  });

  it("does not over-prune: department-prefix still fans genuinely unrouted work", async () => {
    // No delegate AND no assignee — nobody owns it, which is exactly the case
    // department routing exists to serve. Must stay actionable.
    global.fetch = okFetch({
      id: "issue-2240", identifier: "AI-2240",
      delegate: null, assignee: null,
      state: { name: "To Do", type: "unstarted" },
      relations: { nodes: [] },
    }) as unknown as typeof fetch;

    await expect(
      isLinearIssueStillRoutedToAgent("linear-AI-2240", "igor", "department-prefix"),
    ).resolves.toBe(true);
  });

  it("does not over-prune: department-prefix still fans a ticket assigned to an AGENT", async () => {
    // assignee.app === true ⇒ an agent, not a human. Not human-blocked.
    global.fetch = okFetch({
      id: "issue-2241", identifier: "AI-2241",
      delegate: null,
      assignee: { id: IGOR_LINEAR_USER_ID, name: "Igor (Back End Dev)", app: true },
      state: { name: "To Do", type: "unstarted" },
      relations: { nodes: [] },
    }) as unknown as typeof fetch;

    await expect(
      isLinearIssueStillRoutedToAgent("linear-AI-2241", "igor", "department-prefix"),
    ).resolves.toBe(true);
  });

  it("does not over-prune: department-prefix still fans a delegated ticket to a human assignee", async () => {
    // A delegate is present, so an agent IS on the hook — not human-blocked.
    global.fetch = okFetch({
      id: "issue-2242", identifier: "AI-2242",
      delegate: { id: IGOR_LINEAR_USER_ID, name: "Igor (Back End Dev)", app: true },
      assignee: { id: MATT_LINEAR_USER_ID, name: "Matt Henry", app: false },
      state: { name: "To Do", type: "unstarted" },
      relations: { nodes: [] },
    }) as unknown as typeof fetch;

    await expect(
      isLinearIssueStillRoutedToAgent("linear-AI-2242", "igor", "department-prefix"),
    ).resolves.toBe(true);
  });

  describe("isHumanLinearUser", () => {
    const roster = new Set([IGOR_LINEAR_USER_ID]);

    it("treats Linear app users as agents", () => {
      expect(isHumanLinearUser({ id: "x", name: "Astrid (CPO)", app: true }, roster)).toBe(false);
    });

    it("treats non-app users as humans", () => {
      expect(isHumanLinearUser({ id: MATT_LINEAR_USER_ID, name: "Matt Henry", app: false }, roster)).toBe(true);
    });

    it("treats a rostered linearUserId as an agent even when app says otherwise", () => {
      expect(isHumanLinearUser({ id: IGOR_LINEAR_USER_ID, name: "Igor", app: false }, roster)).toBe(false);
    });

    it("is inconclusive-safe: an unknown user with no app flag is NOT pruned as human", () => {
      // Fail-safe: when we can't prove it's a person, keep dispatching rather
      // than silently swallow a legitimate wake.
      expect(isHumanLinearUser({ id: "unknown", name: "Someone" }, roster)).toBe(false);
      expect(isHumanLinearUser(null, roster)).toBe(false);
      expect(isHumanLinearUser(undefined, roster)).toBe(false);
    });
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
