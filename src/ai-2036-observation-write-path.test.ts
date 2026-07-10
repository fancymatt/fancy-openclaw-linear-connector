/**
 * AI-2036 — observations write-path: diagnose & fix the silent skip.
 *
 * The pre-fix guard in workflow-gate.ts read:
 *
 *     if (transition.feedback?.required && options.observationStore && options.feedback)
 *
 * with no `else`. The proxy only built `options.feedback` when the request carried
 * `X-Openclaw-Feedback-Category`, and nothing has ever sent that header — so the
 * third clause was permanently false, the block never executed, and the skip was
 * invisible. `observations` held 0 rows from P4-1 (AI-1378) to AI-2036.
 *
 * The `X-Openclaw-From-Body` warning that the AI-2027 spike blamed sits INSIDE that
 * dead block. It never fired. `regression: the fromBody warning was unreachable`
 * below pins that ordering, because fixing only the from-body header — the spike's
 * recommendation — would still have produced zero rows.
 *
 * AC mapping:
 *   AC1.1 — "silent skip" + "unreachable warning" regressions pin the diagnosis
 *   AC1.2 — "writes a row" integration test, through applyStateTransition
 *   AC1.3 — "counted operational event" for every skip class
 *   AC1.4 — "wake_id column" + index preservation
 * AC1.5 / AC1.6 live in ai-2036-observation-bootstrap.test.ts, which boots the
 * built artifact — a module-level test cannot prove bootstrap wiring.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { ObservationStore } from "./store/observation-store.js";
import {
  parseCategoryFromComment,
  recordObservation,
  registerObservationWritePath,
  resetObservationWritePath,
  getObservationWritePathState,
  resolveFromBody,
  resolveReasonCode,
  type ObservationEventSink,
} from "./store/observation-write-path.js";
import type { OperationalEventInput } from "./store/operational-event-store.js";
import { recordImplementer, clearImplementerStore } from "./implementer-store.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";

/** Both bodies need a linearUserId, or `assign: prior-implementer` fail-closes. */
const TEST_AGENTS = [
  { name: "igor", linearUserId: "user-igor", openclawAgent: "igor", clientId: "c", clientSecret: "s", accessToken: "a", refreshToken: "r", host: "local" },
  { name: "cra", linearUserId: "user-cra", openclawAgent: "cra", clientId: "c", clientSecret: "s", accessToken: "a", refreshToken: "r", host: "local" },
];

// The production dev-impl shape: request-changes at code-review is
// feedback-required, and routes back to the prior implementer.
const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake
break_glass:
  command: escape
  to: intake
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: code-review
  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: done
      - command: request-changes
        to: implementation
        assign:
          mode: required
          default: prior-implementer
        feedback:
          required: true
          category_enum:
            - missing-tests
            - style
            - scope-creep
            - correctness
            - ac-mismatch
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: dev
    grants: [linear:transition]
  - id: review
    grants: [linear:transition]
roles:
  - id: dev
    requires: []
  - id: code-review
    requires: []
bodies:
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: cra
    container: review
    fills_roles: [code-review]
`;

/** Minimal Linear transition-phase fetch mock (mirrors makeTransitionFetch in workflow-gate.test.ts). */
function makeTransitionFetch(issueLabels: Array<{ id: string; name: string }>): typeof globalThis.fetch {
  return (async (url: unknown, init?: { body?: unknown }) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const query = (JSON.parse(bodyText) as { query?: string }).query ?? "";

    if (query.includes("IssueWithLabels")) {
      return new Response(
        JSON.stringify({
          data: { issue: { id: "internal-uuid", team: { id: "team-uuid" }, labels: { nodes: issueLabels } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (query.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({
          data: { team: { labels: { nodes: [{ id: "impl-lbl", name: "state:implementation" }] } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (query.includes("TeamStates")) {
      return new Response(
        JSON.stringify({
          data: { team: { states: { nodes: [{ id: "state-todo-uuid", name: "Todo", type: "unstarted" }] } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (query.includes("issueLabelCreate")) {
      return new Response(
        JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (query.includes("ApplyAtomicTransition") || query.includes("UpdateDelegate")) {
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

/** Collects operational events so we can assert on the telemetry AC1.3 demands. */
function makeEventSink(): ObservationEventSink & { events: OperationalEventInput[] } {
  const events: OperationalEventInput[] = [];
  return { events, append: (e) => void events.push(e) };
}

const CODE_REVIEW_LABELS = [
  { id: "wf-lbl", name: "wf:dev-impl" },
  { id: "cr-lbl", name: "state:code-review" },
];

describe("AI-2036", () => {
  let dir: string;
  let store: ObservationStore;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2036-"));

    const workflowFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    process.env.IMPLEMENTER_STORE_PATH = path.join(dir, "implementer-store.json");

    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: TEST_AGENTS }), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();

    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    resetObservationWritePath();
    clearImplementerStore();

    store = new ObservationStore(path.join(dir, "observations.db"));
    originalFetch = globalThis.fetch;
    globalThis.fetch = makeTransitionFetch(CODE_REVIEW_LABELS);

    // The ticket passed through implementation, so the prior implementer is on record.
    await recordImplementer("AI-2036", "igor", "dev-impl");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── AC1.1: the diagnosis, pinned as regressions ────────────────────────

  describe("AC1.1 — root cause", () => {
    it("regression: a feedback-required transition with NO headers still writes a row", async () => {
      // This is the exact pre-fix production call: the CLI sends neither
      // X-Openclaw-Feedback-Category nor X-Openclaw-From-Body. It used to
      // produce nothing at all, silently.
      const events = makeEventSink();

      await applyStateTransition("request-changes", "AI-2036", "Bearer tok", {
        bodyId: "cra",
        observationStore: store,
        operationalEventStore: events as never,
        feedback: { fromBody: null, reasonCode: null, freeText: "please add tests" },
      });

      expect(store.query({ ticket: "AI-2036" })).toHaveLength(1);
    });

    it("regression: the fromBody warning was unreachable — absent feedback must not be silent", async () => {
      // The spike (AI-2027 §4) blamed X-Openclaw-From-Body. But to warn about a
      // missing from-body the old code first needed a `feedback` object, which the
      // proxy never built. Fixing only the header would still have yielded 0 rows.
      // Post-fix, a transition with `feedback: undefined` entirely — the true
      // pre-fix shape — must still record, not skip and not stay quiet.
      const events = makeEventSink();

      await applyStateTransition("request-changes", "AI-2036", "Bearer tok", {
        bodyId: "cra",
        observationStore: store,
        operationalEventStore: events as never,
        // no `feedback` key at all
      });

      const rows = store.query({ ticket: "AI-2036" });
      expect(rows).toHaveLength(1);
      expect(rows[0].fromBody).toBe("igor");
      expect(events.events.map((e) => e.outcome)).toContain("observation-recorded");
    });

    it("records nothing when the Linear write fails — an observation must not outlive its transition", async () => {
      const events = makeEventSink();
      // Atomic mutation reports success:false → applyStateTransition fails.
      globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
        const bodyText = typeof init?.body === "string" ? init.body : "{}";
        const query = (JSON.parse(bodyText) as { query?: string }).query ?? "";
        if (query.includes("ApplyAtomicTransition")) {
          return new Response(JSON.stringify({ data: { issueUpdate: { success: false } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return makeTransitionFetch(CODE_REVIEW_LABELS)(url as string, init as RequestInit);
      }) as unknown as typeof globalThis.fetch;

      const result = await applyStateTransition("request-changes", "AI-2036", "Bearer tok", {
        bodyId: "cra",
        observationStore: store,
        operationalEventStore: events as never,
        feedback: { fromBody: null, reasonCode: "correctness", freeText: "wrong" },
      });

      expect(result.status).toBe("failed");
      expect(store.query({ ticket: "AI-2036" })).toHaveLength(0);
    });

    it("a transition WITHOUT feedback.required writes nothing and emits nothing", async () => {
      const events = makeEventSink();
      globalThis.fetch = makeTransitionFetch([
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "impl-lbl2", name: "state:implementation" },
      ]);

      await applyStateTransition("submit", "AI-2036", "Bearer tok", {
        bodyId: "igor",
        observationStore: store,
        operationalEventStore: events as never,
      });

      expect(store.query({ ticket: "AI-2036" })).toHaveLength(0);
      expect(events.events).toHaveLength(0);
    });
  });

  // ── AC1.2: the row, with every column populated ────────────────────────

  describe("AC1.2 — a feedback-required transition writes a populated row", () => {
    it("populates ticket, workflow, step, reason_code and from_body", async () => {
      await applyStateTransition("request-changes", "AI-2036", "Bearer tok", {
        bodyId: "cra",
        observationStore: store,
        feedback: { fromBody: null, reasonCode: "missing-tests", freeText: "no tests for the sad path" },
      });

      const rows = store.query({ ticket: "AI-2036" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ticket: "AI-2036",
        workflow: "dev-impl",
        step: "code-review", // the state the feedback was given IN, not the destination
        reasonCode: "missing-tests",
        fromBody: "igor", // resolved from the implementer store, no header needed
        reviewerBody: "cra",
        freeText: "no tests for the sad path",
      });
    });

    it("from_body never collapses onto reviewer_body", async () => {
      // The original objection to writing without a from-body header: a row whose
      // from_body == reviewer_body is useless to P4-2/3/4 aggregation.
      await applyStateTransition("request-changes", "AI-2036", "Bearer tok", {
        bodyId: "cra",
        observationStore: store,
        feedback: { fromBody: null, reasonCode: "correctness", freeText: "off-by-one" },
      });

      const row = store.query({ ticket: "AI-2036" })[0];
      expect(row.fromBody).not.toBe(row.reviewerBody);
    });

    it("with no implementer on record, from_body degrades to 'unknown' rather than dropping the row", async () => {
      clearImplementerStore();
      fs.rmSync(path.join(dir, "implementer-store.json"), { force: true });

      const rec = await recordObservation({
        store,
        ticket: "AI-2036",
        workflow: "dev-impl",
        step: "code-review",
        reviewerBody: "cra",
        resolveImplementer: async () => null,
      });

      expect(rec.written).toBe(true);
      expect(store.query({ ticket: "AI-2036" })[0].fromBody).toBe("unknown");
    });

    it("reads the implementer standing at rejection, not the one Step 3 records for the destination", async () => {
      // applyStateTransition records the destination delegate as the new
      // implementer BEFORE the observation is written. Reading the store after
      // that point would describe where the ticket is going, not whose work was
      // rejected — and when the delegate is not a registered agent, Step 3
      // records the reviewer's own id.
      await applyStateTransition("request-changes", "AI-2036", "Bearer tok", {
        bodyId: "cra",
        observationStore: store,
        // A reviewer redirecting the ticket elsewhere must not rewrite history.
        cliTarget: "cra",
        feedback: { fromBody: null, reasonCode: "correctness", freeText: "wrong" },
      });

      const rows = store.query({ ticket: "AI-2036" });
      expect(rows).toHaveLength(1);
      expect(rows[0].fromBody).toBe("igor");
    });
  });

  // ── AC1.2 (cont.): the resolution ladders, as units ────────────────────

  describe("reason-code resolution ladder", () => {
    it("prefers a valid header", () => {
      expect(resolveReasonCode("scope-creep", "Category: style")).toMatchObject({
        reasonCode: "scope-creep",
        source: "header",
      });
    });

    it("falls back to a Category: marker in the comment", () => {
      expect(resolveReasonCode(null, "Looks good otherwise.\nCategory: ac-mismatch\n")).toMatchObject({
        reasonCode: "ac-mismatch",
        source: "comment",
      });
    });

    it("falls back to 'unclassified' when the reviewer names no category", () => {
      expect(resolveReasonCode(null, "this is wrong, fix it")).toMatchObject({
        reasonCode: "unclassified",
        source: "fallback",
      });
    });

    it("treats a present-but-invalid header as a caller bug, not a missing value", () => {
      // Degrading here would let a typo'd CLI flag quietly poison the corpus.
      expect(resolveReasonCode("mising-tests", "Category: style")).toMatchObject({
        reasonCode: null,
        invalidHeader: true,
      });
    });

    it("parses the markdown reviewers actually write", () => {
      expect(parseCategoryFromComment("- **Category:** `missing-tests`")).toBe("missing-tests");
      expect(parseCategoryFromComment("category = STYLE")).toBe("style");
      expect(parseCategoryFromComment("the category is missing-tests")).toBeNull(); // prose, not a marker
      expect(parseCategoryFromComment("Category: not-a-code")).toBeNull();
      expect(parseCategoryFromComment(null)).toBeNull();
    });
  });

  describe("from-body resolution ladder", () => {
    it("prefers the header, then the implementer store, then 'unknown'", async () => {
      await expect(resolveFromBody("felix", async () => "igor")).resolves.toMatchObject({
        fromBody: "felix",
        source: "header",
      });
      await expect(resolveFromBody(null, async () => "igor")).resolves.toMatchObject({
        fromBody: "igor",
        source: "implementer-store",
      });
      await expect(resolveFromBody(null, async () => null)).resolves.toMatchObject({
        fromBody: "unknown",
        source: "unknown",
      });
    });

    it("refuses to return the reviewer's own id from either rung", async () => {
      // The implementer store records the transitioning body when the resolved
      // delegate is unregistered — so this collapse is reachable, not theoretical.
      await expect(resolveFromBody(null, async () => "cra", "cra")).resolves.toMatchObject({
        fromBody: "unknown",
        source: "unknown",
      });
      await expect(resolveFromBody("cra", async () => null, "cra")).resolves.toMatchObject({
        fromBody: "unknown",
        source: "unknown",
      });
    });

    it("survives an implementer-store failure", async () => {
      await expect(
        resolveFromBody(null, async () => {
          throw new Error("disk gone");
        }),
      ).resolves.toMatchObject({ fromBody: "unknown", source: "unknown" });
    });
  });

  // ── AC1.3: no skip is silent ───────────────────────────────────────────

  describe("AC1.3 — every skip is counted and emitted", () => {
    it("emits a counted observation-skipped event when the store is unwired", async () => {
      const events = makeEventSink();

      const result = await recordObservation({
        store: undefined,
        events,
        ticket: "AI-2036",
        workflow: "dev-impl",
        step: "code-review",
        reviewerBody: "cra",
        resolveImplementer: async () => "igor",
      });

      expect(result).toMatchObject({ written: false, skipReason: "store-unwired" });
      expect(events.events).toHaveLength(1);
      expect(events.events[0]).toMatchObject({
        outcome: "observation-skipped",
        key: "AI-2036",
        errorSummary: "store-unwired",
      });
      expect(getObservationWritePathState().skippedByReason["store-unwired"]).toBe(1);
    });

    it("emits a counted observation-skipped event on an invalid header category", async () => {
      const events = makeEventSink();

      const result = await recordObservation({
        store,
        events,
        ticket: "AI-2036",
        workflow: "dev-impl",
        step: "code-review",
        reviewerBody: "cra",
        headerReasonCode: "typo-code",
        resolveImplementer: async () => "igor",
      });

      expect(result).toMatchObject({ written: false, skipReason: "invalid-reason-code" });
      expect(store.query({ ticket: "AI-2036" })).toHaveLength(0);
      expect(events.events[0]).toMatchObject({ outcome: "observation-skipped", errorSummary: "invalid-reason-code" });
    });

    it("counts a storage failure as a skip and never throws into the transition", async () => {
      const events = makeEventSink();
      const exploding = {
        append() {
          throw new Error("disk full");
        },
      } as unknown as ObservationStore;

      const result = await recordObservation({
        store: exploding,
        events,
        ticket: "AI-2036",
        workflow: "dev-impl",
        step: "code-review",
        reviewerBody: "cra",
        resolveImplementer: async () => "igor",
      });

      expect(result).toMatchObject({ written: false, skipReason: "write-failed" });
      expect(events.events[0]).toMatchObject({ outcome: "observation-skipped", errorSummary: "write-failed" });
      expect(getObservationWritePathState().skippedByReason["write-failed"]).toBe(1);
    });

    it("emits observation-recorded, tagged with how each field was resolved", async () => {
      const events = makeEventSink();

      await recordObservation({
        store,
        events,
        ticket: "AI-2036",
        workflow: "dev-impl",
        step: "code-review",
        reviewerBody: "cra",
        freeText: "nothing categorised here",
        resolveImplementer: async () => "igor",
      });

      expect(events.events[0]).toMatchObject({
        outcome: "observation-recorded",
        detail: expect.objectContaining({
          reasonCode: "unclassified",
          reasonCodeSource: "fallback",
          fromBody: "igor",
          fromBodySource: "implementer-store",
        }),
      });
      expect(getObservationWritePathState().recorded).toBe(1);
    });

    it("a degraded write still counts as recorded, not skipped", async () => {
      await recordObservation({
        store,
        ticket: "AI-2036",
        workflow: "dev-impl",
        step: "code-review",
        reviewerBody: "cra",
        resolveImplementer: async () => null,
      });

      const state = getObservationWritePathState();
      expect(state.recorded).toBe(1);
      expect(state.skipped).toBe(0);
    });
  });

  // ── AC1.4: schema ──────────────────────────────────────────────────────

  describe("AC1.4 — wake_id column", () => {
    it("adds a nullable wake_id, defaulting to NULL with no backfill", () => {
      const id = store.append({
        ticket: "AI-2036",
        workflow: "dev-impl",
        step: "code-review",
        fromBody: "igor",
        reviewerBody: "cra",
        reasonCode: "correctness",
      });
      expect(id).toBeGreaterThan(0);
      expect(store.query({ ticket: "AI-2036" })[0].wakeId).toBeNull();
    });

    it("round-trips a wake_id when the caller knows one", () => {
      store.append({
        ticket: "AI-2036",
        workflow: "dev-impl",
        step: "code-review",
        fromBody: "igor",
        reviewerBody: "cra",
        reasonCode: "correctness",
        wakeId: "wake-abc-123",
      });
      expect(store.query({ ticket: "AI-2036" })[0].wakeId).toBe("wake-abc-123");
    });

    it("preserves the (workflow, step, reason_code) index", () => {
      const db = new Database(path.join(dir, "observations.db"), { readonly: true });
      try {
        const indexes = db.prepare(`PRAGMA index_list('observations')`).all() as Array<{ name: string }>;
        expect(indexes.map((i) => i.name)).toContain("idx_observations_workflow_step_reason");

        const cols = db
          .prepare(`PRAGMA index_info('idx_observations_workflow_step_reason')`)
          .all() as Array<{ name: string }>;
        expect(cols.map((c) => c.name)).toEqual(["workflow", "step", "reason_code"]);
      } finally {
        db.close();
      }
    });

    it("migrates an existing pre-AI-2036 table in place, keeping its rows", () => {
      // Build the old schema by hand, seed it, then let the store migrate it.
      const legacyPath = path.join(dir, "legacy.db");
      const legacy = new Database(legacyPath);
      legacy.exec(`
        CREATE TABLE observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ticket TEXT NOT NULL, workflow TEXT NOT NULL, step TEXT NOT NULL,
          from_body TEXT NOT NULL, reviewer_body TEXT NOT NULL, reason_code TEXT NOT NULL,
          free_text TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO observations (ticket, workflow, step, from_body, reviewer_body, reason_code)
        VALUES ('AI-1', 'dev-impl', 'code-review', 'igor', 'cra', 'style');
      `);
      legacy.close();

      const migrated = new ObservationStore(legacyPath);
      try {
        const rows = migrated.query({ ticket: "AI-1" });
        expect(rows).toHaveLength(1);
        expect(rows[0].wakeId).toBeNull(); // no backfill required
        expect(migrated.total()).toBe(1);
      } finally {
        migrated.close();
      }
    });

    it("migrate() is idempotent across reopens", () => {
      const p = path.join(dir, "twice.db");
      const a = new ObservationStore(p);
      a.close();
      const b = new ObservationStore(p);
      try {
        expect(b.total()).toBe(0);
      } finally {
        b.close();
      }
    });
  });

  // ── liveness registry, as a unit (bootstrap proof is the dist test) ────

  describe("write-path registry", () => {
    it("reports unwired until a bootstrap registers a store", () => {
      expect(getObservationWritePathState()).toMatchObject({ wired: false, subscribed: false, rows: null });

      registerObservationWritePath(store, { subscribed: true });

      expect(getObservationWritePathState()).toMatchObject({ wired: true, subscribed: true, rows: 0 });
      expect(getObservationWritePathState().registeredAt).not.toBeNull();
    });
  });
});
