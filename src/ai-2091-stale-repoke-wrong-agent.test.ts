/**
 * AI-2091 — Connector dispatch integrity: wrong-agent dispatch (vector 1).
 *
 * Regression fixture for the AI-2042 wrong-agent class as it manifests on the
 * one delivery-time path that previously skipped the delegate recheck: the C4
 * stale-session re-poke (`processStaleSession`, src/index.ts). The re-poke fired
 * straight to `stale.agentId` — the agent bound when the wake was ARMED — without
 * re-resolving the current delegate at DELIVERY.
 *
 * Canonical self-referential fixture: on 2026-07-11 a wake for AI-1774 (delegate
 * = Astrid) was delivered to Igor, an agent with no relationship to that ticket.
 * `staleRePokeRecipientValid` is the guard the re-poke path now consults; these
 * tests lock its decision against the real routing logic (mocked Linear fetch).
 */
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { staleRePokeRecipientValid } from "./index.js";
import { reloadAgents } from "./agents.js";

const IGOR_LINEAR_USER_ID = "u-igor";
const ASTRID_LINEAR_USER_ID = "u-astrid";

function mockIssue(issue: unknown): void {
  global.fetch = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { issue } }),
  }) as unknown as typeof fetch;
}

describe("AI-2091: stale C4 re-poke resolves recipient at delivery, not arm time", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  let agentsDir: string;

  beforeEach(() => {
    // Give "igor" a resolvable linearUserId + token so the delegate recheck
    // actually verifies identity (rather than short-circuiting to allow-through).
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2091-agents-"));
    const agentsFile = path.join(agentsDir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          { name: "igor", linearUserId: IGOR_LINEAR_USER_ID, openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
          { name: "astrid", linearUserId: ASTRID_LINEAR_USER_ID, openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        ],
      }),
      "utf8",
    );
    process.env = { ...originalEnv, AGENTS_FILE: agentsFile };
    reloadAgents();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    reloadAgents();
    fs.rmSync(agentsDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("drops the re-poke when the delegate changed to another agent (AI-1774 fixture)", async () => {
    // Ticket now delegated to Astrid; the stale session's arm-time agent is Igor.
    mockIssue({
      id: "issue-1774",
      identifier: "AI-1774",
      delegate: { id: ASTRID_LINEAR_USER_ID, name: "Astrid (CPO)" },
      assignee: null,
      state: { name: "Backlog", type: "backlog" },
      relations: { nodes: [] },
    });

    await expect(staleRePokeRecipientValid("linear-AI-1774", "igor")).resolves.toBe(false);
  });

  it("allows the re-poke when the stale agent is still the delegate", async () => {
    mockIssue({
      id: "issue-1044",
      identifier: "AI-1044",
      delegate: { id: IGOR_LINEAR_USER_ID, name: "Igor (Back End Dev)" },
      assignee: null,
      state: { name: "Doing", type: "started" },
      relations: { nodes: [] },
    });

    await expect(staleRePokeRecipientValid("linear-AI-1044", "igor")).resolves.toBe(true);
  });

  it("drops the re-poke when the ticket was handed back (delegate cleared)", async () => {
    mockIssue({
      id: "issue-1044",
      identifier: "AI-1044",
      delegate: null,
      assignee: null,
      state: { name: "Todo", type: "unstarted" },
      relations: { nodes: [] },
    });

    await expect(staleRePokeRecipientValid("linear-AI-1044", "igor")).resolves.toBe(false);
  });

  it("drops the re-poke when the ticket no longer exists (phantom)", async () => {
    mockIssue(null);

    await expect(staleRePokeRecipientValid("linear-AI-9999", "igor")).resolves.toBe(false);
  });

  it("fails OPEN on a transient Linear error — never silently loses a legitimate resume", async () => {
    global.fetch = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    await expect(staleRePokeRecipientValid("linear-AI-1044", "igor")).resolves.toBe(true);
  });

  it("consults the delegate routing check exactly once, with the delegate reason", async () => {
    const check = jest
      .fn<(sessionKey: string, agentId: string, reason: "delegate") => Promise<boolean>>()
      .mockResolvedValue(false);

    await expect(staleRePokeRecipientValid("linear-AI-1774", "igor", check)).resolves.toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith("linear-AI-1774", "igor", "delegate");
  });
});
