/**
 * INF-34 — barrier: `fetchChildren` fail-open — an unreadable child set reads as
 * zero children and satisfies the barrier.
 *
 * `fetchChildren` caught every error and returned `[]`, and `evaluateBarrier`
 * reads `[]` as vacuous satisfaction (the AI-1730 contract). A transient Linear
 * API error therefore advanced a parent past a barrier whose children it never
 * read, and logged the result as healthy.
 *
 * ACs covered here:
 *
 *   AC1: `fetchChildren` distinguishes a successful read of zero children from a
 *        failed read — `null` on failure, `[]` on a genuine empty read. A
 *        GraphQL-level error in the response body counts as a failure.
 *   AC2: `evaluateBarrier` / `attemptBarrierTransition` / `onManagingEntry` do
 *        NOT transition when the child set could not be read. The parent stays
 *        put and the failure is surfaced (error log + a comment naming the
 *        barrier).
 *   AC3: A successful read of genuinely zero children still advances — the
 *        AI-1730 vacuous-satisfaction path is preserved, not reverted.
 *
 * The AI-1730 contract itself is not under test here; `barrier-zero-child.test.ts`
 * owns it and stays green unmodified.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fetchChildren,
  evaluateBarrier,
  attemptBarrierTransition,
  onManagingEntry,
} from "./barrier.js";
import { resetWorkflowCache } from "./workflow-gate.js";

// Barrier-ness is config-driven (AI-1992) — the engine reads the parent's
// workflow def to confirm its current state declares `barrier: true`. Point the
// registry at an isolated defs dir holding the canonical ux-audit fixture.
let _defsDir: string;
let _origDefsDir: string | undefined;

beforeAll(() => {
  _origDefsDir = process.env.WORKFLOW_DEFS_DIR;
  _defsDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf34-defs-"));
  const fixturesDir = path.resolve(process.cwd(), "src/__fixtures__");
  for (const f of ["canonical-ux-audit.yaml", "canonical-sprint.yaml", "canonical-dev-impl.yaml"]) {
    fs.copyFileSync(path.join(fixturesDir, f), path.join(_defsDir, f));
  }
  process.env.WORKFLOW_DEFS_DIR = _defsDir;
  resetWorkflowCache();
});

afterAll(() => {
  if (_origDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = _origDefsDir;
  else delete process.env.WORKFLOW_DEFS_DIR;
  resetWorkflowCache();
});

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  resetWorkflowCache();
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Helpers ──────────────────────────────────────────────────────────────

type Recorder = {
  /** Every GraphQL query name the code under test sent. */
  queries: string[];
  /** Bodies of every commentCreate mutation sent. */
  comments: string[];
  /** True if a label-swap mutation was issued — i.e. the parent actually moved. */
  mutated: () => boolean;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A full transition-flow mock. Every query but ParentChildren is healthy — the
 * child-set read is the only thing that fails, which is exactly the INF-34
 * scenario: a transient blip on one query with everything else fine.
 *
 * `childrenResponse` decides how the child read behaves. Dispatch is on the
 * query string, never on call order — call-order mocks drain out of sequence
 * and produce a red that proves nothing.
 */
function installFetch(opts: {
  childrenResponse: () => Promise<Response>;
  parentState?: string;
  workflowId?: string;
}): Recorder {
  const wfId = opts.workflowId ?? "ux-audit";
  const state = opts.parentState ?? "managing";
  const rec: Recorder = {
    queries: [],
    comments: [],
    mutated: () => rec.queries.some((q) => q.includes("UpdateLabels") || q.includes("issueUpdate")),
  };

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    rec.queries.push(query);

    if (query.includes("ParentChildren")) {
      return opts.childrenResponse();
    }

    if (query.includes("ParentState") || query.includes("ParentLabels") || query.includes("IssueLabels")) {
      return json({
        data: {
          issue: {
            id: "parent-internal-id",
            team: { id: "team-uuid" },
            labels: {
              nodes: [
                { id: "wf-lbl", name: `wf:${wfId}` },
                { id: "state-lbl", name: `state:${state}` },
              ],
            },
          },
        },
      });
    }

    if (query.includes("issueLabelCreate")) {
      return json({ data: { issueLabelCreate: { success: true, issueLabel: { id: "label-new" } } } });
    }

    if (query.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: [] } } } });
    }

    if (query.includes("UpdateLabels") || query.includes("issueUpdate")) {
      return json({ data: { issueUpdate: { success: true } } });
    }

    if (query.includes("commentCreate")) {
      const vars = parsed.variables ?? {};
      const body = (vars.body ?? vars.input ?? "") as unknown;
      rec.comments.push(typeof body === "string" ? body : JSON.stringify(body));
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } });
    }

    // resolveInternalId and anything else identifier-shaped
    if (query.includes("issue(")) {
      return json({ data: { issue: { id: "parent-internal-id" } } });
    }

    return json({ data: {} });
  }) as typeof globalThis.fetch;

  return rec;
}

/** A healthy read returning exactly these children. */
function childrenOk(children: Array<{ identifier: string; labels: string[] }>): () => Promise<Response> {
  return async () =>
    json({
      data: {
        issue: {
          children: {
            nodes: children.map((c) => ({
              identifier: c.identifier,
              labels: { nodes: c.labels.map((l) => ({ name: l })) },
            })),
          },
        },
      },
    });
}

/** The three ways the child read fails in the wild. */
const FAILURE_MODES: Array<{ name: string; response: () => Promise<Response> }> = [
  {
    name: "network throw",
    response: async () => {
      throw new Error("ECONNRESET");
    },
  },
  {
    name: "non-200 (transient 502)",
    response: async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
  },
  {
    name: "GraphQL errors body (200)",
    response: async () =>
      json({
        errors: [{ message: "Internal server error", extensions: { code: "INTERNAL_SERVER_ERROR" } }],
      }),
  },
];

const LIVE_CHILDREN = [
  { identifier: "CHILD-1", labels: ["wf:dev-impl", "state:implementation"] },
  { identifier: "CHILD-2", labels: ["wf:dev-impl", "state:code-review"] },
  { identifier: "CHILD-3", labels: ["wf:dev-impl", "state:write-tests"] },
];

// ── AC1: unreadable ≠ empty ──────────────────────────────────────────────

describe("AC1: fetchChildren distinguishes a failed read from an empty read", () => {
  for (const mode of FAILURE_MODES) {
    it(`returns null on ${mode.name} — not []`, async () => {
      installFetch({ childrenResponse: mode.response });
      const children = await fetchChildren("PARENT-1", "token");
      expect(children).toBeNull();
    });
  }

  it("returns [] on a successful read of genuinely zero children", async () => {
    installFetch({ childrenResponse: childrenOk([]) });
    const children = await fetchChildren("PARENT-1", "token");
    expect(children).toEqual([]);
  });

  // The failure modes above are each caught by more than one layer (a 502 with
  // an HTML body also fails to parse; an errors-only body also has no nodes).
  // These two isolate the guards that are load-bearing *alone* — without them
  // the read looks like a clean empty one and nothing downstream can tell.

  it("returns null on a non-200 whose body would otherwise parse as zero children", async () => {
    installFetch({
      childrenResponse: async () =>
        json({ data: { issue: { children: { nodes: [] } } } }, 502),
    });
    const children = await fetchChildren("PARENT-1", "token");
    expect(children).toBeNull();
  });

  it("returns null on a GraphQL partial response — errors alongside usable data", async () => {
    // GraphQL may return `errors` *and* a populated `data` (a partial result).
    // The children connection resolved to empty only because the query errored,
    // so trusting `data` here is the original bug with extra steps.
    installFetch({
      childrenResponse: async () =>
        json({
          errors: [{ message: "Something went wrong while resolving children" }],
          data: { issue: { children: { nodes: [] } } },
        }),
    });
    const children = await fetchChildren("PARENT-1", "token");
    expect(children).toBeNull();
  });

  it("returns null when the issue itself is absent from the response", async () => {
    installFetch({ childrenResponse: async () => json({ data: { issue: null } }) });
    const children = await fetchChildren("PARENT-1", "token");
    expect(children).toBeNull();
  });

  it("returns the child set on a successful non-empty read", async () => {
    installFetch({ childrenResponse: childrenOk(LIVE_CHILDREN) });
    const children = await fetchChildren("PARENT-1", "token");
    expect(children).toHaveLength(3);
    expect(children?.map((c) => c.identifier)).toEqual(["CHILD-1", "CHILD-2", "CHILD-3"]);
  });
});

// ── AC2: the barrier fails closed on an unreadable read ──────────────────

describe("AC2: evaluateBarrier does not report satisfaction on an unreadable read", () => {
  for (const mode of FAILURE_MODES) {
    it(`${mode.name} → allTerminal false, readFailed true, not a 0/0 report`, async () => {
      installFetch({ childrenResponse: mode.response });
      const result = await evaluateBarrier("PARENT-1", "token");
      expect(result.readFailed).toBe(true);
      expect(result.allTerminal).toBe(false);
    });
  }

  it("a successful zero-child read is NOT flagged as a failed read", async () => {
    installFetch({ childrenResponse: childrenOk([]) });
    const result = await evaluateBarrier("PARENT-1", "token");
    expect(result.readFailed).toBeFalsy();
    expect(result.allTerminal).toBe(true);
    expect(result.totalChildren).toBe(0);
  });
});

describe("AC2: attemptBarrierTransition does not move the parent on an unreadable read", () => {
  for (const mode of FAILURE_MODES) {
    it(`${mode.name} → no transition, no label mutation, error surfaced`, async () => {
      const rec = installFetch({ childrenResponse: mode.response });
      const result = await attemptBarrierTransition("PARENT-1", "token");

      expect(result.transitioned).toBe(false);
      expect(rec.mutated()).toBe(false);
      expect(result.error).toMatch(/read|unreadable|fetch/i);
    });
  }

  it(`alarms with a comment naming the barrier and the parent`, async () => {
    const rec = installFetch({ childrenResponse: FAILURE_MODES[0].response });
    await attemptBarrierTransition("PARENT-1", "token");

    expect(rec.comments).toHaveLength(1);
    expect(rec.comments[0]).toMatch(/barrier/i);
    expect(rec.comments[0]).toContain("PARENT-1");
  });

  it("does not report a 0/0 barrier summary for an unreadable read", async () => {
    const rec = installFetch({ childrenResponse: FAILURE_MODES[0].response });
    const result = await attemptBarrierTransition("PARENT-1", "token");

    // The old bug's signature: "barrier satisfied (0/0 terminal)" on a parent
    // with three live children. The alarm must not read as a healthy summary.
    expect(rec.comments.join("\n")).not.toMatch(/All 0 child\(ren\) reached terminal state/);
    expect(result.transitioned).toBe(false);
  });
});

describe("AC2: onManagingEntry does not move the parent on an unreadable read", () => {
  for (const mode of FAILURE_MODES) {
    it(`${mode.name} → no transition and no label mutation`, async () => {
      const rec = installFetch({ childrenResponse: mode.response });
      const result = await onManagingEntry("PARENT-1", "token");

      expect(result?.transitioned ?? false).toBe(false);
      expect(rec.mutated()).toBe(false);
    });
  }

  it("surfaces the failure rather than returning a silent no-op", async () => {
    const rec = installFetch({ childrenResponse: FAILURE_MODES[0].response });
    const result = await onManagingEntry("PARENT-1", "token");

    // A silent `null` is indistinguishable from "children still in progress" —
    // the caller in workflow-gate.ts logs that as normal flow.
    expect(result).not.toBeNull();
    expect(result?.error).toMatch(/read|unreadable|fetch/i);
    expect(rec.comments.join("\n")).toMatch(/barrier/i);
  });
});

// ── AC3: the AI-1730 / AI-2523 waive path is preserved ───────────────────

describe("AC3: a successful read of genuinely zero children still advances", () => {
  it("onManagingEntry advances a real zero-child parent (AI-1730 preserved)", async () => {
    const rec = installFetch({ childrenResponse: childrenOk([]) });
    const result = await onManagingEntry("PARENT-1", "token");

    expect(result).not.toBeNull();
    expect(result?.transitioned).toBe(true);
    expect(result?.totalChildren).toBe(0);
    expect(rec.mutated()).toBe(true);
  });

  it("attemptBarrierTransition still advances when all children are terminal", async () => {
    const rec = installFetch({
      childrenResponse: childrenOk([
        { identifier: "CHILD-1", labels: ["wf:dev-impl", "state:done"] },
        { identifier: "CHILD-2", labels: ["wf:dev-impl", "state:done"] },
      ]),
    });
    const result = await attemptBarrierTransition("PARENT-1", "token");

    expect(result.transitioned).toBe(true);
    expect(result.totalChildren).toBe(2);
    expect(rec.mutated()).toBe(true);
  });

  it("still waits when children are readable but in progress", async () => {
    const rec = installFetch({ childrenResponse: childrenOk(LIVE_CHILDREN) });
    const result = await attemptBarrierTransition("PARENT-1", "token");

    expect(result.transitioned).toBe(false);
    expect(result.totalChildren).toBe(3);
    expect(rec.mutated()).toBe(false);
    // Not an alarm — this is normal flow, and must stay quiet.
    expect(rec.comments).toHaveLength(0);
  });
});
