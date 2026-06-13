import { jest } from "@jest/globals";
import { classify, buildRecoveryComment, type ToolCallSummary, type LastAssistantMessage, type StaleSnapshot, STALE_CLASS_NAMES, buildSnapshot, writeSnapshot, aggregateDigest, formatDigestSummary, recoverTicket } from "./stale-session-forensics.js";
import { StaleRedispatchCounter } from "./stale-redispatch-counter.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── classify() tests ────────────────────────────────────────────────────────

const emptyToolCalls: ToolCallSummary = { byName: {}, totalCalls: 0, last10: [] };

function makeAssistant(overrides: Partial<LastAssistantMessage> = {}): LastAssistantMessage {
  return {
    fullText: "Done with the work.",
    hasQuestion: false,
    hasToolCalls: false,
    stopReason: "end_turn",
    timestamp: "2026-05-17T22:00:00Z",
    ...overrides,
  };
}

describe("classify", () => {
  test("C4 — never started (no tool calls, no text)", () => {
    expect(classify(null, emptyToolCalls, [])).toBe("C4");
    expect(classify(makeAssistant({ fullText: "" }), emptyToolCalls, [])).toBe("C4");
  });

  test("C6 — errored", () => {
    const assistant = makeAssistant({ stopReason: "error" });
    expect(classify(assistant, emptyToolCalls, ["Model error at 22:00"])).toBe("C6");
  });

  test("C5 — looped (many tool calls, no productive text)", () => {
    const manyToolCalls: ToolCallSummary = {
      byName: { read: 25 },
      totalCalls: 25,
      last10: Array(10).fill({ name: "read", arguments: {}, result: "success" as const, timestamp: "2026-05-17T22:00:00Z" }),
    };
    expect(classify(makeAssistant({ fullText: "" }), manyToolCalls, [])).toBe("C5");
  });

  test("C5 — not triggered when productive text exists", () => {
    const manyToolCalls: ToolCallSummary = {
      byName: { read: 25 },
      totalCalls: 25,
      last10: Array(10).fill({ name: "read", arguments: {}, result: "success" as const, timestamp: "2026-05-17T22:00:00Z" }),
    };
    expect(classify(makeAssistant({ fullText: "I've completed the implementation of the new forensics module. Here's a summary..." }), manyToolCalls, [])).not.toBe("C5");
  });

  test("C2 — tool hang (last tool call has no result)", () => {
    const toolCalls: ToolCallSummary = {
      byName: { exec: 3 },
      totalCalls: 3,
      last10: [
        { name: "exec", arguments: { command: "npm test" }, result: "no-result", timestamp: "2026-05-17T22:00:00Z" },
      ],
    };
    const assistant = makeAssistant({ hasToolCalls: true, stopReason: "tool_use" });
    expect(classify(assistant, toolCalls, [])).toBe("C2");
  });

  test("C1 — waiting on user (question, end_turn)", () => {
    const assistant = makeAssistant({
      fullText: "Should I proceed with option A or option B?",
      hasQuestion: true,
      stopReason: "end_turn",
    });
    expect(classify(assistant, emptyToolCalls, [])).toBe("C1");
  });

  test("C3 — silent completion (long text, end_turn, no tool calls)", () => {
    const assistant = makeAssistant({
      fullText: "I've completed the implementation. The new module handles session timeout detection and creates forensic snapshots for debugging.",
      stopReason: "end_turn",
    });
    expect(classify(assistant, emptyToolCalls, [])).toBe("C3");
  });

  test("C3 — tool calls completed but didn't transition", () => {
    const toolCalls: ToolCallSummary = {
      byName: { edit: 2, write: 1 },
      totalCalls: 3,
      last10: [
        { name: "write", arguments: { path: "/tmp/test.ts" }, result: "success", timestamp: "2026-05-17T22:00:00Z" },
      ],
    };
    expect(classify(makeAssistant(), toolCalls, [])).toBe("C3");
  });

  test("C-UNK — edge case", () => {
    const assistant = makeAssistant({ fullText: "hmm", stopReason: "unknown" });
    expect(classify(assistant, emptyToolCalls, [])).toBe("C-UNK");
  });

  test("loop threshold is configurable", () => {
    const manyToolCalls: ToolCallSummary = {
      byName: { read: 15 },
      totalCalls: 15,
      last10: Array(10).fill({ name: "read", arguments: {}, result: "success" as const, timestamp: "2026-05-17T22:00:00Z" }),
    };
    // Default threshold is 20, so 15 calls should NOT be C5
    expect(classify(makeAssistant({ fullText: "" }), manyToolCalls, [])).not.toBe("C5");
    // But with threshold=10, it should be C5
    expect(classify(makeAssistant({ fullText: "" }), manyToolCalls, [], 10)).toBe("C5");
  });
});

// ── STALE_CLASS_NAMES coverage ─────────────────────────────────────────────

describe("STALE_CLASS_NAMES", () => {
  const classes = ["C1", "C2", "C3", "C4", "C5", "C6", "C-UNK"] as const;
  for (const cls of classes) {
    test(`has name for ${cls}`, () => {
      expect(STALE_CLASS_NAMES[cls]).toBeTruthy();
      expect(typeof STALE_CLASS_NAMES[cls]).toBe("string");
    });
  }
});

// ── buildSnapshot ──────────────────────────────────────────────────────────

describe("buildSnapshot", () => {
  test("produces valid snapshot for a stale session", () => {
    const snapshot = buildSnapshot(
      {
        agentId: "igor",
        sessionKey: "linear-AI-1010",
        startedAt: Date.now() - 30 * 60 * 1000,
        timeoutMs: 25 * 60 * 1000,
        pendingTickets: ["linear-AI-1011"],
      },
      { openclawHome: "/nonexistent" },
    );

    expect(snapshot.capturedAt).toBeTruthy();
    expect(snapshot.metadata.agentId).toBe("igor");
    expect(snapshot.metadata.ticketId).toBe("linear-AI-1010");
    expect(snapshot.metadata.totalDurationMs).toBeGreaterThan(0);
    expect(snapshot.classification).toMatch(/^C[1-6]|C-UNK$/);
    expect(snapshot.toolCallSummary.totalCalls).toBe(0); // nonexistent file = no events
    expect(snapshot.lastAssistantMessage).toBeNull();
    expect(snapshot.linearTicket.identifier).toBe("AI-1010");
  });
});

// ── writeSnapshot ──────────────────────────────────────────────────────────

describe("writeSnapshot", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forensics-test-"));

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes valid JSON to diagnostics dir", () => {
    const snapshot = buildSnapshot(
      {
        agentId: "test-agent",
        sessionKey: "linear-AI-9999",
        startedAt: Date.now() - 30 * 60 * 1000,
        timeoutMs: 25 * 60 * 1000,
        pendingTickets: [],
      },
      { openclawHome: "/nonexistent" },
    );

    const filePath = writeSnapshot(snapshot, { diagnosticsDir: tmpDir });
    expect(fs.existsSync(filePath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(written.capturedAt).toBe(snapshot.capturedAt);
    expect(written.metadata.agentId).toBe("test-agent");
  });
});

// ── aggregateDigest / formatDigestSummary ──────────────────────────────────

describe("aggregateDigest", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-test-"));

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty summary when no digest file exists", () => {
    const summary = aggregateDigest({ diagnosticsDir: tmpDir });
    expect(summary.totalStaleSessions).toBe(0);
    expect(summary.entries).toHaveLength(0);
  });

  test("reads digest entries and aggregates", () => {
    // Write some digest entries
    const digestPath = path.join(tmpDir, "digest.jsonl");
    const entries = [
      { capturedAt: new Date().toISOString(), agent: "igor", ticket: "linear-AI-1001", classification: "C3", classificationName: "Silent completion", totalDurationMs: 1800000, toolCallCount: 5, stopReason: "end_turn", errors: 0, diagnosticPath: "/tmp/test.json" },
      { capturedAt: new Date().toISOString(), agent: "igor", ticket: "linear-AI-1002", classification: "C2", classificationName: "Tool hang", totalDurationMs: 1500000, toolCallCount: 3, stopReason: "tool_use", errors: 0, diagnosticPath: "/tmp/test2.json" },
      { capturedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), agent: "ai", ticket: "linear-AI-900", classification: "C4", classificationName: "Never started", totalDurationMs: 1500000, toolCallCount: 0, stopReason: null, errors: 0, diagnosticPath: "/tmp/old.json" },
    ];
    fs.writeFileSync(digestPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const summary = aggregateDigest({ diagnosticsDir: tmpDir }, 7);
    expect(summary.totalStaleSessions).toBe(2); // old entry filtered out
    expect(summary.byClass["C3"]).toBe(1);
    expect(summary.byClass["C2"]).toBe(1);
    expect(summary.byAgent["igor"]).toBe(2);
  });

  test("formatDigestSummary produces readable text", () => {
    const summary = {
      period: { from: "2026-05-10T00:00:00Z", to: "2026-05-17T00:00:00Z" },
      totalStaleSessions: 4,
      byClass: { C3: 2, C2: 1, C4: 1 },
      byAgent: { igor: 3, ai: 1 },
      entries: [],
    };
    const text = formatDigestSummary(summary);
    expect(text).toContain("Total stale sessions: 4");
    expect(text).toContain("C3");
    expect(text).toContain("50%"); // 2/4 = 50%
    expect(text).toContain("igor: 3");
  });
});

// ── StaleRedispatchCounter ─────────────────────────────────────────────────

describe("StaleRedispatchCounter", () => {
  let dbPath: string;
  let counter: StaleRedispatchCounter;

  beforeEach(() => {
    dbPath = `/tmp/stale-redispatch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    counter = new StaleRedispatchCounter(dbPath);
  });

  afterEach(() => {
    counter.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
  });

  test("get returns 0 for unknown ticket", () => {
    expect(counter.get("linear-AI-9999")).toBe(0);
  });

  test("incrementAndGet returns 1 on first call", () => {
    expect(counter.incrementAndGet("linear-AI-1001")).toBe(1);
  });

  test("incrementAndGet increments on each call", () => {
    expect(counter.incrementAndGet("linear-AI-1002")).toBe(1);
    expect(counter.incrementAndGet("linear-AI-1002")).toBe(2);
    expect(counter.incrementAndGet("linear-AI-1002")).toBe(3);
  });

  test("get returns current count after increments", () => {
    counter.incrementAndGet("linear-AI-1003");
    counter.incrementAndGet("linear-AI-1003");
    expect(counter.get("linear-AI-1003")).toBe(2);
  });

  test("reset removes entry, get returns 0 afterwards", () => {
    counter.incrementAndGet("linear-AI-1004");
    counter.incrementAndGet("linear-AI-1004");
    counter.reset("linear-AI-1004");
    expect(counter.get("linear-AI-1004")).toBe(0);
  });

  test("tracks separate counts per ticket", () => {
    counter.incrementAndGet("linear-AI-A");
    counter.incrementAndGet("linear-AI-A");
    counter.incrementAndGet("linear-AI-B");
    expect(counter.get("linear-AI-A")).toBe(2);
    expect(counter.get("linear-AI-B")).toBe(1);
  });
});

// ── buildRecoveryComment — attempt parameter ───────────────────────────────

function makeSnapshot(cls: StaleSnapshot["classification"]): StaleSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    metadata: {
      agentId: "igor",
      ticketId: "linear-AI-1044",
      sessionKey: "agent:igor:linear-AI-1044",
      sessionFile: null,
      sessionStartedAt: Date.now() - 30 * 60 * 1000,
      lastActivityAt: Date.now(),
      timeoutMs: 25 * 60 * 1000,
      totalDurationMs: 30 * 60 * 1000,
    },
    lastAssistantMessage: null,
    lastToolCall: { name: "exec", arguments: { command: "npm test" }, result: "no-result", timestamp: new Date().toISOString() },
    toolCallSummary: { byName: { exec: 1 }, totalCalls: 1, last10: [] },
    linearTicket: { identifier: "AI-1044", stateAtStart: null, stateAtTimeout: null, lastCommentAtStart: null, lastCommentAtTimeout: null, commentCountAtStart: null, commentCountAtTimeout: null },
    classification: cls,
    errors: [],
    diagnosticPath: "",
  };
}

describe("buildRecoveryComment — C2 attempt tracking", () => {
  test("no attempt param: includes standard re-dispatch text, no attempt line", () => {
    const comment = buildRecoveryComment(makeSnapshot("C2"));
    expect(comment).toContain("Ticket returned to Todo for re-dispatch.");
    expect(comment).not.toContain("Re-dispatch attempt");
  });

  test("below cap (attempt 1 of 3): appends attempt count", () => {
    const comment = buildRecoveryComment(makeSnapshot("C2"), 1, 3);
    expect(comment).toContain("Ticket returned to Todo for re-dispatch.");
    expect(comment).toContain("Re-dispatch attempt **1 of 3**.");
  });

  test("below cap (attempt 2 of 3): appends correct count", () => {
    const comment = buildRecoveryComment(makeSnapshot("C2"), 2, 3);
    expect(comment).toContain("Re-dispatch attempt **2 of 3**.");
    expect(comment).not.toContain("Max re-dispatch attempts reached");
  });

  test("at cap (attempt 3 of 3): shows escalation text, not re-dispatch", () => {
    const comment = buildRecoveryComment(makeSnapshot("C2"), 3, 3);
    expect(comment).toContain("Max re-dispatch attempts reached (**3/3**). Escalating to human review.");
    expect(comment).not.toContain("Ticket returned to Todo for re-dispatch.");
  });
});

describe("buildRecoveryComment — C4 attempt tracking", () => {
  test("below cap: appends attempt count", () => {
    const comment = buildRecoveryComment(makeSnapshot("C4"), 1, 3);
    expect(comment).toContain("Ticket returned to Todo for re-dispatch.");
    expect(comment).toContain("Re-dispatch attempt **1 of 3**.");
  });

  test("at cap: shows escalation text", () => {
    const comment = buildRecoveryComment(makeSnapshot("C4"), 3, 3);
    expect(comment).toContain("Max re-dispatch attempts reached (**3/3**). Escalating to human review.");
    expect(comment).not.toContain("Ticket returned to Todo for re-dispatch.");
  });
});

// ── recoverTicket — redispatch cap integration ─────────────────────────────

function makeFetchMock() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockImplementation(async (_url: unknown, opts?: unknown) => {
    const reqOpts = opts as RequestInit | undefined;
    const body = reqOpts?.body ? JSON.parse(reqOpts.body as string) : {};
    const query: string = body.query ?? "";

    if (query.includes("IssueWithTeam")) {
      return { ok: true, json: async () => ({ data: { issue: { id: "issue-123", team: { id: "team-456" } } } }) };
    }
    if (query.includes("TeamStates") || query.includes("workflow")) {
      return { ok: true, json: async () => ({ data: { team: { workflow: { states: [{ id: "state-todo", name: "Todo", type: "unstarted" }] } } } }) };
    }
    if (query.includes("commentCreate")) {
      return { ok: true, json: async () => ({ data: { commentCreate: { comment: { id: "comment-1" } } } }) };
    }
    // AI-1306: state + ownership are now a single RecoverIssue mutation (no separate OwnershipUpdate)
    if (query.includes("RecoverIssue") || query.includes("issueUpdate")) {
      return { ok: true, json: async () => ({ data: { issueUpdate: { success: true, issue: { id: "issue-123", state: { name: "Todo" } } } } }) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

describe("recoverTicket — C2/C4 redispatch cap", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/stale-redispatch-recover-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LINEAR_API_KEY = "test-key";
  });

  afterEach(() => {
    // restore fetch if needed
    delete process.env.LINEAR_API_KEY;
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
  });

  test("C2 below cap: re-dispatches normally, increments counter", async () => {
    global.fetch = makeFetchMock() as unknown as typeof fetch;

    const snapshot = makeSnapshot("C2");
    const result = await recoverTicket(snapshot, "igor", {
      redispatchDbPath: dbPath,
      maxRedispatchAttempts: 3,
    });

    expect(result.success).toBe(true);

    const counter = new StaleRedispatchCounter(dbPath);
    expect(counter.get("linear-AI-1044")).toBe(1);
    counter.close();

    const fetchMock = global.fetch as ReturnType<typeof jest.fn>;
    const commentCall = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(([, opts]) => {
      const b = JSON.parse((opts?.body ?? "{}") as string);
      return b.query?.includes("commentCreate");
    });
    expect(commentCall).toBeDefined();
    const commentBody = JSON.parse((commentCall![1].body ?? "{}") as string);
    expect(commentBody.variables.body).toContain("Re-dispatch attempt **1 of 3**.");
    expect(commentBody.variables.body).toContain("Ticket returned to Todo for re-dispatch.");
  });

  test("C2 at cap: converts to needs-human semantics, correct comment", async () => {
    const setupCounter = new StaleRedispatchCounter(dbPath);
    setupCounter.incrementAndGet("linear-AI-1044");
    setupCounter.incrementAndGet("linear-AI-1044");
    setupCounter.close();

    global.fetch = makeFetchMock() as unknown as typeof fetch;

    const snapshot = makeSnapshot("C2");
    const result = await recoverTicket(snapshot, "igor", {
      redispatchDbPath: dbPath,
      maxRedispatchAttempts: 3,
      humanAssigneeLinearId: "human-linear-id",
    });

    expect(result.success).toBe(true);

    const fetchMock = global.fetch as ReturnType<typeof jest.fn>;
    const commentCall = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(([, opts]) => {
      const b = JSON.parse((opts?.body ?? "{}") as string);
      return b.query?.includes("commentCreate");
    });
    expect(commentCall).toBeDefined();
    const commentBody = JSON.parse((commentCall![1].body ?? "{}") as string);
    expect(commentBody.variables.body).toContain("Max re-dispatch attempts reached (**3/3**). Escalating to human review.");
    expect(commentBody.variables.body).not.toContain("Ticket returned to Todo for re-dispatch.");

    // AI-1306: ownership is now combined into the single RecoverIssue mutation
    const recoverCall = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(([, opts]) => {
      const b = JSON.parse((opts?.body ?? "{}") as string);
      return b.query?.includes("RecoverIssue");
    });
    expect(recoverCall).toBeDefined();
    const recoverBody = JSON.parse((recoverCall![1].body ?? "{}") as string);
    expect(recoverBody.variables.input.assigneeId).toBe("human-linear-id");
    expect(recoverBody.variables.input.delegateId).toBeNull();
  });

  // AI-1578 (AC2/AC3b): C4 FIRST stall re-pokes the existing delegate instead of
  // orphaning — delegate retained, no state change, rePoke signal set.
  test("C4 first stall (attempt 1): re-pokes delegate, retains delegate, no RecoverIssue mutation", async () => {
    global.fetch = makeFetchMock() as unknown as typeof fetch;

    const snapshot = makeSnapshot("C4");
    const result = await recoverTicket(snapshot, "igor", {
      redispatchDbPath: dbPath,
      maxRedispatchAttempts: 3,
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe("re-poke-c4");
    expect(result.rePoke).toBe(true);

    const fetchMock = global.fetch as ReturnType<typeof jest.fn>;

    // A re-poke comment is posted (delegate retained, not orphaned).
    const commentCall = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(([, opts]) => {
      const b = JSON.parse((opts?.body ?? "{}") as string);
      return b.query?.includes("commentCreate");
    });
    expect(commentCall).toBeDefined();
    const commentBody = JSON.parse((commentCall![1].body ?? "{}") as string);
    expect(commentBody.variables.body).toContain("re-poking delegate");
    expect(commentBody.variables.body).not.toContain("Ticket returned to Todo for re-dispatch.");

    // No RecoverIssue mutation → delegate NOT cleared, state NOT changed.
    const recoverCall = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(([, opts]) => {
      const b = JSON.parse((opts?.body ?? "{}") as string);
      return b.query?.includes("RecoverIssue") || b.query?.includes("issueUpdate");
    });
    expect(recoverCall).toBeUndefined();
  });

  // AI-1578 (AC3c): C4 SECOND consecutive stall sheds the delegate and re-dispatches
  // (existing orphan behavior preserved), with the correct attempt count.
  test("C4 second stall (attempt 2, below cap): re-dispatches normally, clears delegate, attempt count 2", async () => {
    const setupCounter = new StaleRedispatchCounter(dbPath);
    setupCounter.incrementAndGet("linear-AI-1044"); // simulate the first stall (re-poked)
    setupCounter.close();

    global.fetch = makeFetchMock() as unknown as typeof fetch;

    const snapshot = makeSnapshot("C4");
    const result = await recoverTicket(snapshot, "igor", {
      redispatchDbPath: dbPath,
      maxRedispatchAttempts: 3,
    });

    expect(result.success).toBe(true);
    expect(result.rePoke).toBeFalsy();

    const fetchMock = global.fetch as ReturnType<typeof jest.fn>;
    const commentCall = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(([, opts]) => {
      const b = JSON.parse((opts?.body ?? "{}") as string);
      return b.query?.includes("commentCreate");
    });
    const commentBody = JSON.parse((commentCall![1].body ?? "{}") as string);
    expect(commentBody.variables.body).toContain("Re-dispatch attempt **2 of 3**.");

    // RecoverIssue mutation clears the delegate (orphan/re-dispatch).
    const recoverCall = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(([, opts]) => {
      const b = JSON.parse((opts?.body ?? "{}") as string);
      return b.query?.includes("RecoverIssue");
    });
    expect(recoverCall).toBeDefined();
    const recoverBody = JSON.parse((recoverCall![1].body ?? "{}") as string);
    expect(recoverBody.variables.input.delegateId).toBeNull();
  });

  test("C4 at cap: escalates to human", async () => {
    const setupCounter = new StaleRedispatchCounter(dbPath);
    setupCounter.incrementAndGet("linear-AI-1044");
    setupCounter.incrementAndGet("linear-AI-1044");
    setupCounter.close();

    global.fetch = makeFetchMock() as unknown as typeof fetch;

    const snapshot = makeSnapshot("C4");
    const result = await recoverTicket(snapshot, "igor", {
      redispatchDbPath: dbPath,
      maxRedispatchAttempts: 3,
      humanAssigneeLinearId: "human-linear-id",
    });

    expect(result.success).toBe(true);

    const fetchMock = global.fetch as ReturnType<typeof jest.fn>;
    const commentCall = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(([, opts]) => {
      const b = JSON.parse((opts?.body ?? "{}") as string);
      return b.query?.includes("commentCreate");
    });
    const commentBody = JSON.parse((commentCall![1].body ?? "{}") as string);
    expect(commentBody.variables.body).toContain("Max re-dispatch attempts reached (**3/3**). Escalating to human review.");
  });

  test("AI-1306: recoverTicket issues a single atomic mutation (state + ownership, no separate OwnershipUpdate call)", async () => {
    // Regression guard: two separate mutations (state, then ownership) created a race where the
    // state-change webhook arrived before the delegate-clear propagated, re-waking the agent.
    // The combined RecoverIssue mutation eliminates this window.
    global.fetch = makeFetchMock() as unknown as typeof fetch;

    const snapshot = makeSnapshot("C1"); // C1 → needs human, so assigneeId will be set
    await recoverTicket(snapshot, "igor", {
      redispatchDbPath: dbPath,
      humanAssigneeLinearId: "human-linear-id",
    });

    const fetchMock = global.fetch as ReturnType<typeof jest.fn>;
    const allCalls = fetchMock.mock.calls as Array<[string, RequestInit]>;

    // Must have exactly one RecoverIssue (combined) call — no separate OwnershipUpdate
    const recoverCalls = allCalls.filter(([, opts]) => {
      const b = JSON.parse((opts?.body ?? "{}") as string);
      return b.query?.includes("RecoverIssue");
    });
    expect(recoverCalls).toHaveLength(1);

    // The single call must carry BOTH stateId and ownership fields
    const recoverBody = JSON.parse((recoverCalls[0][1].body ?? "{}") as string);
    expect(recoverBody.variables.input.stateId).toBeDefined();
    expect(recoverBody.variables.input.delegateId).toBeNull();
    expect(recoverBody.variables.input.assigneeId).toBe("human-linear-id");

    // No separate OwnershipUpdate call must exist
    const ownershipOnlyCalls = allCalls.filter(([, opts]) => {
      const b = JSON.parse((opts?.body ?? "{}") as string);
      return b.query?.includes("OwnershipUpdate");
    });
    expect(ownershipOnlyCalls).toHaveLength(0);
  });
});

// ── recoverTicket — terminal guard + robust state resolution ────────────────

function makeFetchMockWithState(opts: { stateName?: string; stateType?: string; teamStates?: Array<{ id: string; name: string; type: string }> }) {
  const stateName = opts.stateName ?? "In Progress";
  const stateType = opts.stateType ?? "started";
  const teamStates = opts.teamStates ?? [{ id: "state-todo", name: "To Do", type: "unstarted" }];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockImplementation(async (_url: unknown, reqOpts?: unknown) => {
    const body = (reqOpts as RequestInit | undefined)?.body ? JSON.parse((reqOpts as RequestInit).body as string) : {};
    const query: string = body.query ?? "";
    if (query.includes("IssueWithTeam")) {
      return { ok: true, json: async () => ({ data: { issue: { id: "issue-123", team: { id: "team-456" }, state: { name: stateName, type: stateType } } } }) };
    }
    if (query.includes("TeamStates") || query.includes("workflow")) {
      return { ok: true, json: async () => ({ data: { team: { workflow: { states: teamStates } } } }) };
    }
    if (query.includes("commentCreate")) {
      return { ok: true, json: async () => ({ data: { commentCreate: { comment: { id: "comment-1" } } } }) };
    }
    if (query.includes("RecoverIssue") || query.includes("issueUpdate")) {
      return { ok: true, json: async () => ({ data: { issueUpdate: { success: true, issue: { id: "issue-123", state: { name: "To Do" } } } } }) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

describe("recoverTicket — terminal guard", () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = `/tmp/stale-terminal-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LINEAR_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.LINEAR_API_KEY;
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  test("skips recovery when ticket is already terminal (completed) — no comment, no mutation", async () => {
    global.fetch = makeFetchMockWithState({ stateName: "Done", stateType: "completed" }) as unknown as typeof fetch;

    const result = await recoverTicket(makeSnapshot("C4"), "igor", { redispatchDbPath: dbPath });

    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped-terminal");

    const fetchMock = global.fetch as ReturnType<typeof jest.fn>;
    const allCalls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    // Only the IssueWithTeam query should have fired — no comment, no RecoverIssue.
    const mutating = allCalls.filter(([, o]) => {
      const b = JSON.parse((o?.body ?? "{}") as string);
      return b.query?.includes("commentCreate") || b.query?.includes("RecoverIssue");
    });
    expect(mutating).toHaveLength(0);
  });

  test("skips recovery when ticket is canceled", async () => {
    global.fetch = makeFetchMockWithState({ stateName: "Canceled", stateType: "canceled" }) as unknown as typeof fetch;
    const result = await recoverTicket(makeSnapshot("C2"), "igor", { redispatchDbPath: dbPath });
    expect(result.action).toBe("skipped-terminal");
  });

  test("proceeds with recovery when ticket is still active (started)", async () => {
    global.fetch = makeFetchMockWithState({ stateName: "In Progress", stateType: "started" }) as unknown as typeof fetch;
    // C2 (not C4) so we exercise the full recovery mutation path — C4 first-stall
    // short-circuits into a re-poke (AI-1578) and never issues RecoverIssue.
    const result = await recoverTicket(makeSnapshot("C2"), "igor", { redispatchDbPath: dbPath });
    expect(result.action).not.toBe("skipped-terminal");
    const fetchMock = global.fetch as ReturnType<typeof jest.fn>;
    const allCalls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const recoverCall = allCalls.find(([, o]) => JSON.parse((o?.body ?? "{}") as string).query?.includes("RecoverIssue"));
    expect(recoverCall).toBeDefined();
  });
});

describe("recoverTicket — robust state-name resolution", () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = `/tmp/stale-stateres-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LINEAR_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.LINEAR_API_KEY;
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  test('resolves "To Do" target by exact name', async () => {
    global.fetch = makeFetchMockWithState({
      teamStates: [{ id: "s-todo", name: "To Do", type: "unstarted" }, { id: "s-done", name: "Done", type: "completed" }],
    }) as unknown as typeof fetch;
    await recoverTicket(makeSnapshot("C2"), "igor", { redispatchDbPath: dbPath });
    const fetchMock = global.fetch as ReturnType<typeof jest.fn>;
    const recoverCall = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(([, o]) => JSON.parse((o?.body ?? "{}") as string).query?.includes("RecoverIssue"));
    const recoverBody = JSON.parse((recoverCall![1].body ?? "{}") as string);
    expect(recoverBody.variables.input.stateId).toBe("s-todo");
  });

  test('falls back to unstarted type when team uses a different name (e.g. "Backlog Ready")', async () => {
    global.fetch = makeFetchMockWithState({
      teamStates: [{ id: "s-ready", name: "Backlog Ready", type: "unstarted" }, { id: "s-done", name: "Done", type: "completed" }],
    }) as unknown as typeof fetch;
    await recoverTicket(makeSnapshot("C2"), "igor", { redispatchDbPath: dbPath });
    const fetchMock = global.fetch as ReturnType<typeof jest.fn>;
    const recoverCall = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(([, o]) => JSON.parse((o?.body ?? "{}") as string).query?.includes("RecoverIssue"));
    const recoverBody = JSON.parse((recoverCall![1].body ?? "{}") as string);
    expect(recoverBody.variables.input.stateId).toBe("s-ready");
  });
});
