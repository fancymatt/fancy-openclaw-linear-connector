/**
 * Rebuild WS1 — comment routing enrichment (2026-07-03 pilot finding).
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { enrichCommentEventForRouting } from "./index.js";

const savedFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = savedFetch; });

function commentEvent(data: Record<string, unknown>) {
  return {
    type: "Comment",
    action: "create",
    actor: { id: "actor-1", name: "someone" },
    createdAt: "2026-07-03T08:00:00.000Z",
    data,
    raw: {},
  } as never;
}

describe("enrichCommentEventForRouting", () => {
  it("grafts the issue delegate onto a bare comment event", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { issue: { delegate: { id: "ai-user-id" }, assignee: null } } }), { status: 200 })
    ) as typeof globalThis.fetch;
    const ev = commentEvent({ id: "c1", body: "status?", issueId: "issue-1" });
    await enrichCommentEventForRouting(ev);
    expect((ev as { data: { delegate?: { id: string } } }).data.delegate).toEqual({ id: "ai-user-id" });
  });

  it("leaves events with an existing delegate untouched (no fetch)", async () => {
    let called = 0;
    globalThis.fetch = (async () => { called++; return new Response("{}"); }) as typeof globalThis.fetch;
    const ev = commentEvent({ id: "c1", body: "x", issueId: "issue-1", delegate: { id: "pre" } });
    await enrichCommentEventForRouting(ev);
    expect(called).toBe(0);
    expect((ev as { data: { delegate: { id: string } } }).data.delegate).toEqual({ id: "pre" });
  });

  it("fails open when the fetch throws", async () => {
    globalThis.fetch = (async () => { throw new Error("network"); }) as typeof globalThis.fetch;
    const ev = commentEvent({ id: "c1", body: "x", issueId: "issue-1" });
    await enrichCommentEventForRouting(ev);
    expect((ev as { data: { delegate?: unknown } }).data.delegate).toBeUndefined();
  });

  it("ignores non-Comment events", async () => {
    let called = 0;
    globalThis.fetch = (async () => { called++; return new Response("{}"); }) as typeof globalThis.fetch;
    const ev = { type: "Issue", action: "update", data: { id: "i1" }, raw: {} } as never;
    await enrichCommentEventForRouting(ev);
    expect(called).toBe(0);
  });
});
