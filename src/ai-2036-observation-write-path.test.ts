/**
 * AI-2036 — Integration proof for the observations write path.
 *
 * These tests drive the REAL `applyStateTransition` (the same function the proxy
 * calls on every governed transition) against a mocked Linear API, and assert on
 * rows in a real SQLite ObservationStore. They are the regression net for the
 * bug that kept `observations` at 0 rows from AI-1378 until now:
 *
 *   The proxy only built a `feedback` payload when the X-Openclaw-Feedback-
 *   Category header was present. No CLI ever sent that header, so
 *   `options.feedback` was always undefined and the gate's observation block
 *   short-circuited — writing nothing and logging nothing.
 *
 * AC mapping:
 *   AC1.2 — a feedback-required transition writes a row with populated
 *           (ticket, workflow, step, reason_code, from_body), with NO headers.
 *   AC1.3 — every skip is counted and emits an operational event.
 *   AC1.4 — wake_id round-trips and is nullable.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";

import { applyStateTransition, resetWorkflowCache, resetNativeStateCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { clearImplementerStore } from "./implementer-store.js";
import { clearAcRecordStore } from "./ac-record-store.js";
import { ObservationStore, DEGRADED_REASON_CODE } from "./store/observation-store.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import {
  getObservationLiveness,
  resetObservationWiring,
  registerObservationWriter,
} from "./observation-wiring.js";
import { recordFeedbackObservation, parseReasonCodeFromComment } from "./observation-hook.js";

const SEMANTIC_TO_UUID: Record<string, string> = {
  todo: "state-todo-uuid",
  doing: "state-doing-uuid",
  thinking: "state-thinking-uuid",
  done: "state-done-uuid",
  invalid: "state-invalid-uuid",
};

const CATEGORIES = ["missing-tests", "style", "scope-creep", "correctness", "ac-mismatch"];

/**
 * `orphan-review` exists to exercise the from-body-unresolved skip: its
 * destination role has zero bodies, so no delegate resolves and no implementer
 * was ever recorded.
 */
const WORKFLOW_YAML = `
id: dev-impl
version: 1
states:
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: code-review

  - id: code-review
    owner_role: reviewer
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: done
      - command: request-changes
        to: implementation
        assign: { default: prior-implementer }
        feedback:
          required: true
          category_enum: [${CATEGORIES.join(", ")}]
      - command: ac-fail
        to: orphan-work
        feedback:
          required: true
          category_enum: [${CATEGORIES.join(", ")}]

  - id: orphan-work
    owner_role: nobody
    kind: normal
    native_state: todo
    transitions: []

  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

/** `nobody` is a role no body fills — it drives the from-body-unresolved skip. */
const POLICY_YAML = `
capabilities:
  - id: linear:transition

containers:
  - id: dev
    grants: [linear:transition]
  - id: reviewer
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: reviewer
    requires: [linear:transition]
  - id: nobody
    requires: [linear:transition]

bodies:
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: cra
    container: reviewer
    fills_roles: [reviewer]
`;

/** Mocks the Linear GraphQL surface applyStateTransition touches. */
function makeFetch(currentLabels: string[]): typeof globalThis.fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const q = parsed.query ?? "";

    if (q.includes("IssueWithLabels")) {
      return new Response(JSON.stringify({
        data: {
          issue: {
            id: "issue-internal-uuid",
            team: { id: "team-uuid" },
            labels: { nodes: currentLabels.map((name) => ({ id: `lbl-${name}`, name })) },
          },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (q.includes("TeamLabels")) {
      return new Response(JSON.stringify({ data: { team: { labels: { nodes: [] } } } }), { status: 200 });
    }
    if (q.includes("issueLabelCreate")) {
      const name = (parsed.variables as Record<string, unknown>).name as string;
      return new Response(JSON.stringify({
        data: { issueLabelCreate: { success: true, issueLabel: { id: `lbl-${name}` } } },
      }), { status: 200 });
    }
    if (q.includes("TeamStates")) {
      return new Response(JSON.stringify({
        data: {
          team: {
            states: {
              nodes: Object.entries(SEMANTIC_TO_UUID).map(([name, id]) => ({
                id,
                name: name.charAt(0).toUpperCase() + name.slice(1),
                type: name === "done" ? "completed" : name === "invalid" ? "canceled" : "started",
              })),
            },
          },
        },
      }), { status: 200 });
    }
    if (q.includes("ApplyAtomicTransition") || q.includes("issueUpdate")) {
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof globalThis.fetch;
}

let dir: string;
let store: ObservationStore;
let events: OperationalEventStore;
let seq = 0;

/** A fresh ticket id per case — observations are append-only. */
const ticket = () => `AI-OBS-${++seq}`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2036-"));

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const workflowFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(workflowFile, WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = workflowFile;

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [
      { name: "igor", linearUserId: "igor-uuid", clientId: "i", clientSecret: "i", accessToken: "i", refreshToken: "i" },
      { name: "cra", linearUserId: "cra-uuid", clientId: "c", clientSecret: "c", accessToken: "c", refreshToken: "c" },
    ],
  }), "utf8");
  process.env.AGENTS_FILE = agentsFile;
  reloadAgents();
});

afterAll(() => {
  store?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  clearImplementerStore();
  clearAcRecordStore();
  resetObservationWiring();

  store?.close();
  store = new ObservationStore(path.join(dir, `obs-${seq}-${Date.now()}.db`));
  events = new OperationalEventStore(path.join(dir, `events-${seq}-${Date.now()}.db`));
  globalThis.fetch = makeFetch(["wf:dev-impl", "state:code-review"]);
});

// ── AC1.2 ─────────────────────────────────────────────────────────────
describe("AC1.2: a feedback-required transition writes a populated observation row", () => {
  it("writes a row with NO X-Openclaw-* feedback headers — the exact case that produced 0 rows", async () => {
    const id = ticket();

    const result = await applyStateTransition("request-changes", id, "Bearer tok", {
      bodyId: "cra",
      observationStore: store,
      operationalEventStore: events,
      // Precisely the production payload before AI-2036: no category header,
      // no from-body header — only the comment the CLI already requires.
      feedback: { fromBody: null, reasonCode: null, freeText: "tests are missing for the retry path" },
    });
    expect(result.status).toBe("applied");

    const rows = store.query({ ticket: id });
    expect(rows).toHaveLength(1);

    // Every field AC1.2 names must be populated.
    expect(rows[0].ticket).toBe(id);
    expect(rows[0].workflow).toBe("dev-impl");
    expect(rows[0].step).toBe("code-review");
    expect(rows[0].reasonCode).toBe(DEGRADED_REASON_CODE);
    expect(rows[0].fromBody).toBe("igor");

    // from_body must be the implementer, never the reviewer — that distinction
    // is the whole point of the P4-2 per-implementer rollup.
    expect(rows[0].reviewerBody).toBe("cra");
    expect(rows[0].fromBody).not.toBe(rows[0].reviewerBody);
  });

  it("uses the reviewer's `Category:` comment directive as the reason code", async () => {
    const id = ticket();
    await applyStateTransition("request-changes", id, "Bearer tok", {
      bodyId: "cra",
      observationStore: store,
      operationalEventStore: events,
      feedback: { reasonCode: null, freeText: "Please add coverage.\nCategory: missing-tests\n" },
    });

    const rows = store.query({ ticket: id });
    expect(rows[0].reasonCode).toBe("missing-tests");
    expect(getObservationLiveness().degraded).toBe(0);
  });

  it("still prefers the X-Openclaw-Feedback-Category / From-Body headers when a client sends them", async () => {
    const id = ticket();
    await applyStateTransition("request-changes", id, "Bearer tok", {
      bodyId: "cra",
      observationStore: store,
      operationalEventStore: events,
      feedback: { fromBody: "sage", reasonCode: "correctness", freeText: "off-by-one" },
    });

    const rows = store.query({ ticket: id });
    expect(rows[0].reasonCode).toBe("correctness");
    expect(rows[0].fromBody).toBe("sage");
  });

  it("degrades rather than drops when a reviewer supplies a category outside category_enum", async () => {
    const id = ticket();
    await applyStateTransition("request-changes", id, "Bearer tok", {
      bodyId: "cra",
      observationStore: store,
      operationalEventStore: events,
      feedback: { reasonCode: "not-a-real-category", freeText: "hmm" },
    });

    const rows = store.query({ ticket: id });
    expect(rows).toHaveLength(1);
    expect(rows[0].reasonCode).toBe(DEGRADED_REASON_CODE);

    const degradedEvents = events.query({ outcome: "observation-degraded" });
    expect(degradedEvents).toHaveLength(1);
    expect((degradedEvents[0].detail as Record<string, unknown>).rejectedReasonCode).toBe("not-a-real-category");
  });

  it("writes no observation for a transition without feedback.required", async () => {
    const id = ticket();
    await applyStateTransition("approve", id, "Bearer tok", {
      bodyId: "cra",
      observationStore: store,
      operationalEventStore: events,
    });

    expect(store.query({ ticket: id })).toHaveLength(0);
    const live = getObservationLiveness();
    expect(live.appended).toBe(0);
    expect(live.skipped).toBe(0);
  });
});

// ── AC1.3 ─────────────────────────────────────────────────────────────
describe("AC1.3: skipped observation writes are counted and never silent", () => {
  it("emits a counted `store-unwired` event when no store reaches the transition handler", async () => {
    const id = ticket();
    await applyStateTransition("request-changes", id, "Bearer tok", {
      bodyId: "cra",
      observationStore: undefined, // the AI-1773/AI-1775 dead-wiring failure mode
      operationalEventStore: events,
      feedback: { reasonCode: null, freeText: "no store wired" },
    });

    const live = getObservationLiveness();
    expect(live.skipped).toBe(1);
    expect(live.skipsByReason["store-unwired"]).toBe(1);
    expect(live.registered).toBe(false);

    const skips = events.query({ outcome: "observation-skipped" });
    expect(skips).toHaveLength(1);
    expect((skips[0].detail as Record<string, unknown>).skipReason).toBe("store-unwired");
    expect(skips[0].key).toBe(id);
  });

  it("emits a counted `from-body-unresolved` event when no implementer can be derived", async () => {
    const id = ticket();
    // ac-fail routes to a role with zero bodies: no delegate resolves, and no
    // implementer was ever recorded for this ticket.
    await applyStateTransition("ac-fail", id, "Bearer tok", {
      bodyId: "cra",
      observationStore: store,
      operationalEventStore: events,
      feedback: { reasonCode: "correctness", freeText: "AC not met" },
    });

    expect(store.query({ ticket: id })).toHaveLength(0);

    const live = getObservationLiveness();
    expect(live.skipsByReason["from-body-unresolved"]).toBe(1);
    expect(events.query({ outcome: "observation-skipped" })).toHaveLength(1);
  });

  it("counts a `write-failed` skip and never throws when the insert fails", () => {
    store.close(); // force the insert to throw
    const result = recordFeedbackObservation({
      issueId: "AI-BOOM",
      workflowId: "dev-impl",
      step: "code-review",
      reviewerBody: "cra",
      fromBodyCandidates: ["igor"],
      observationStore: store,
      operationalEventStore: events,
    });

    expect(result).toEqual({ written: false, skipReason: "write-failed" });
    expect(getObservationLiveness().skipsByReason["write-failed"]).toBe(1);
    expect(events.query({ outcome: "observation-skipped" })).toHaveLength(1);

    store = new ObservationStore(path.join(dir, `obs-recover-${Date.now()}.db`));
  });

  it("counts a degraded write separately from a clean one", async () => {
    await applyStateTransition("request-changes", ticket(), "Bearer tok", {
      bodyId: "cra", observationStore: store, operationalEventStore: events,
      feedback: { reasonCode: "style", freeText: "nit" },
    });
    await applyStateTransition("request-changes", ticket(), "Bearer tok", {
      bodyId: "cra", observationStore: store, operationalEventStore: events,
      feedback: { reasonCode: null, freeText: "no category here" },
    });

    const live = getObservationLiveness();
    expect(live.appended).toBe(2);
    expect(live.degraded).toBe(1);
    expect(live.skipped).toBe(0);
    expect(events.query({ outcome: "observation-written" })).toHaveLength(1);
    expect(events.query({ outcome: "observation-degraded" })).toHaveLength(1);
  });
});

// ── AC1.4 ─────────────────────────────────────────────────────────────
describe("AC1.4: observations.wake_id", () => {
  it("is nullable and defaults to NULL", () => {
    const id = store.append({
      ticket: "AI-1", workflow: "dev-impl", step: "code-review",
      fromBody: "igor", reviewerBody: "cra", reasonCode: "style",
    });
    expect(store.query({ ticket: "AI-1" })[0].wakeId).toBeNull();
    expect(id).toBeGreaterThan(0);
  });

  it("round-trips a wake_id supplied by the transition", async () => {
    const id = ticket();
    await applyStateTransition("request-changes", id, "Bearer tok", {
      bodyId: "cra",
      observationStore: store,
      operationalEventStore: events,
      wakeId: "wake-abc-123",
      feedback: { reasonCode: "correctness", freeText: "x" },
    });
    expect(store.query({ ticket: id })[0].wakeId).toBe("wake-abc-123");
  });

  it("preserves the (workflow, step, reason_code) index", () => {
    const indexes = (store as unknown as { db: { prepare(s: string): { all(): Array<{ name: string }> } } })
      .db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
    expect(indexes.map((i) => i.name)).toContain("idx_observations_workflow_step_reason");
  });

  it("migrates an existing pre-wake_id table additively, without dropping rows", () => {
    // Simulate a live production file: original schema, one row, no wake_id.
    const legacyPath = path.join(dir, `legacy-${Date.now()}.db`);
    const legacy = new ObservationStore(legacyPath);
    (legacy as unknown as { db: { exec(s: string): void } }).db.exec(
      `DROP TABLE observations;
       CREATE TABLE observations (
         id INTEGER PRIMARY KEY AUTOINCREMENT, ticket TEXT NOT NULL, workflow TEXT NOT NULL,
         step TEXT NOT NULL, from_body TEXT NOT NULL, reviewer_body TEXT NOT NULL,
         reason_code TEXT NOT NULL, free_text TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now')));
       INSERT INTO observations (ticket, workflow, step, from_body, reviewer_body, reason_code)
       VALUES ('AI-OLD', 'dev-impl', 'code-review', 'igor', 'cra', 'style');`,
    );
    legacy.close();

    const migrated = new ObservationStore(legacyPath);
    const rows = migrated.query({ ticket: "AI-OLD" });
    expect(rows).toHaveLength(1);
    expect(rows[0].wakeId).toBeNull(); // no backfill required
    expect(migrated.count()).toBe(1);
    migrated.close();
  });
});

// ── Hook units ────────────────────────────────────────────────────────
describe("parseReasonCodeFromComment", () => {
  it.each([
    ["Category: correctness", "correctness"],
    ["reason_code: style", "style"],
    ["  Reason:  ac-mismatch  ", "ac-mismatch"],
    ["- Category: scope-creep", "scope-creep"],
  ])("accepts %p", (text, expected) => {
    expect(parseReasonCodeFromComment(text, CATEGORIES)).toBe(expected);
  });

  it("ignores a category mentioned in prose rather than declared on its own line", () => {
    expect(parseReasonCodeFromComment("this is a correctness problem, category: none really", CATEGORIES)).toBeNull();
  });

  it("rejects a directive naming a category outside the transition's enum", () => {
    expect(parseReasonCodeFromComment("Category: vibes", CATEGORIES)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseReasonCodeFromComment(null, CATEGORIES)).toBeNull();
    expect(parseReasonCodeFromComment("", CATEGORIES)).toBeNull();
  });
});

describe("registerObservationWriter", () => {
  it("reports registered=false until bootstrap registers a store", () => {
    expect(getObservationLiveness().registered).toBe(false);
    expect(getObservationLiveness().dbPath).toBeNull();

    registerObservationWriter(store);

    const live = getObservationLiveness();
    expect(live.registered).toBe(true);
    expect(live.dbPath).toBe(store.dbPath);
    expect(live.rows).toBe(0);
  });
});
