/**
 * INF-104 — Transition-stamped session dispatch has no retry/reassign on
 * transient failure — silently strands work
 *
 * AC mapping:
 *   AC1 — A transition-stamped session dispatch that fails transiently retries
 *         (bounded backoff) and succeeds once the transient condition clears,
 *         with no manual intervention.
 *   AC2 — If retries are exhausted, the ticket routes through the existing
 *         `unreachable → reassign to ai / flag for manual routing` fallback —
 *         it does not sit silently.
 *   AC3 — A ticket in a work-eligible state with a stamped delegate but no
 *         live/collected session is detectable (emits a reason code, e.g.
 *         `session-never-spawned`) rather than looking healthy.
 *   AC4 — Regression test: simulate a dispatch failure at transition time
 *         (503 / unreachable) → assert the session is eventually spawned OR
 *         the reassign fallback fires; assert the ticket never rests stamped-
 *         but-session-less.
 *
 * @jest-environment node
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import yaml from "js-yaml";
import { setStateAtomic, type SetStateAtomicResult } from "./workflow-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-104-"));
}

function writeWorkflowDef(dir: string): string {
  const file = path.join(dir, "dev-impl.yaml");
  const def = {
    id: "dev-impl",
    version: 1,
    entry_state: "intake",
    break_glass: { command: "escape", to: "escape", owner_role: "steward" },
    states: [
      { id: "intake", owner_role: "steward", kind: "normal", native_state: "todo", transitions: [{ command: "accept", to: "implementation" }] },
      { id: "implementation", owner_role: "dev", kind: "normal", native_state: "todo", transitions: [{ command: "submit", to: "done" }] },
      { id: "done", kind: "terminal", native_state: "done" },
      { id: "escape", kind: "terminal", native_state: "invalid" },
    ],
  };
  fs.writeFileSync(file, yaml.dump(def), "utf8");
  return file;
}

function writePolicyYaml(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  const policy = {
    bodies: [
      { id: "igor", container: "dev", fills_roles: ["dev"] },
      { id: "ai", container: "steward", fills_roles: ["steward"] },
    ],
    containers: [
      { id: "dev", grants: ["linear:transition"] },
      { id: "steward", grants: ["linear:transition", "human:escalate"] },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(policy), "utf8");
  return file;
}

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [
      {
        name: "igor",
        linearUserId: "user-igor-linear-id",
        clientId: "c", clientSecret: "s",
        accessToken: "lin_igor", refreshToken: "r", host: "local",
      },
      {
        name: "ai",
        linearUserId: "user-ai-linear-id",
        clientId: "c", clientSecret: "s",
        accessToken: "lin_ai", refreshToken: "r", host: "local",
      },
    ],
  }), "utf8");
  return file;
}

// ── Minimal Linear API mock ─────────────────────────────────────────────────
//
// Sequences through:
//   1. fetchIssueWithLabels (initial)  → returns current labels
//   2. TeamLabels lookup               → returns label ids
//   3. TeamStates lookup               → returns mock states
//   4. issueUpdate mutation            → returns success:true
//   5. VerifyTransitionWrite re-check  → returns updated labels
//   (6+ repeated for each retry cycle of sendsWakeUp)

const MOCK_TEAM_STATES = [
  { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
  { id: "state-done-uuid", name: "Done", type: "completed" },
  { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
];

interface MockOptions {
  fromLabels?: string[];
  updateSuccess?: boolean;
  consistencyLabels?: string[];
  throwOnUpdate?: boolean;
}

function makeSetStateFetch(opts: MockOptions): typeof globalThis.fetch {
  const {
    fromLabels = ["wf:dev-impl", "state:implementation"],
    updateSuccess = true,
    consistencyLabels,
    throwOnUpdate = false,
  } = opts;

  const afterLabels = consistencyLabels ?? fromLabels;
  let callIndex = 0;
  // Track the delegate last written via issueUpdate so VerifyTransitionWrite
  // echoes it back — otherwise the AI-1762 consistency check always fails.
  let writtenDelegate: string | null = null;

  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";

    if (bodyText.includes("TeamStates")) {
      return new Response(
        JSON.stringify({ data: { team: { states: { nodes: MOCK_TEAM_STATES } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (bodyText.includes("VerifyTransitionWrite")) {
      const labels = consistencyLabels ?? afterLabels;
      const landedState = labels.find((l) => l.startsWith("state:"))?.slice("state:".length) ?? "";
      const nativeByState: Record<string, string> = {
        done: "state-done-uuid",
        implementation: "state-todo-uuid",
        intake: "state-todo-uuid",
        escape: "state-invalid-uuid",
      };
      const delegateResp = writtenDelegate ? { id: writtenDelegate } : null;
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              labels: { nodes: labels.map((name) => ({ name })) },
              delegate: delegateResp,
              state: { id: nativeByState[landedState] ?? "state-todo-uuid" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (bodyText.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "label-state-target-uuid", name: "state:implementation" },
                  { id: "label-state-done-uuid", name: "state:done" },
                  { id: "label-state-escape-uuid", name: "state:escape" },
                  { id: "label-state-intake-uuid", name: "state:intake" },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (bodyText.includes("ApplyAtomicTransition") || (bodyText.includes("issueUpdate") && bodyText.includes("labelIds"))) {
      if (throwOnUpdate) throw new Error("simulated Linear API failure");
      // Capture the delegate that was written so verification passes
      try {
        const parsed = JSON.parse(bodyText) as { variables?: { delegateId?: string | null } };
        if (parsed.variables?.delegateId !== undefined) {
          writtenDelegate = parsed.variables.delegateId;
        }
      } catch { /* ignore parse errors */ }
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: updateSuccess } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (bodyText.includes("IssueWithLabels")) {
      const isRecheck = callIndex++ > 0;
      const labels = isRecheck ? (consistencyLabels ?? fromLabels) : fromLabels;
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "internal-issue-uuid",
              team: { id: "team-uuid" },
              labels: { nodes: labels.map((name) => ({ id: `label-${name.replace(/[:/]/g, "-")}-uuid`, name })) },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe("INF-104: transition-stamped dispatch retry on transient failure", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    dir = tempDir();
    writeWorkflowDef(dir);
    writePolicyYaml(dir);
    writeAgents(dir);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(dir, "def-state-snapshot.json");
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    process.env.AGENTS_FILE = path.join(dir, "agents.json");
    reloadAgents();
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
  });

  // ── AC1: Retry with bounded backoff ──────────────────────────────────────

  it("AC1: retries sendWakeUp when dispatch fails transiently (503-style)", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:intake"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:implementation"],
    });

    // sendWakeUp fails transiently (503) for the first 2 calls, succeeds on 3rd
    let wakeAttempts = 0;
    const sendWakeUp = jest.fn(async (_agentId: string, _ticketId: string) => {
      wakeAttempts++;
      if (wakeAttempts <= 2) {
        throw new Error("503 Service Unavailable — upstream gateway timeout");
      }
      // succeeds on 3rd attempt
    });

    const result: SetStateAtomicResult = await setStateAtomic(
      "AI-9999", "implementation", "igor", "Bearer test-token",
      { sendWakeUp },
    );

    // AC1: After transient failures, the retry loop must call sendWakeUp more than once.
    // Current implementation: calls sendWakeUp once and catches the error — no retry.
    // Failing assertion: sendWakeUp is called multiple times (retried).
    expect(wakeAttempts).toBeGreaterThan(1);

    // AC1: The ticket must eventually be marked as redispatched after retry succeeds.
    // Current implementation: redispatched is undefined when sendWakeUp throws.
    // Failing assertion: redispatched is set after retry succeeds.
    expect(result.redispatched).toBe("igor");

    // AC1: The set-state itself must still report success (fail-open for the write).
    expect(result.ok).toBe(true);
  });

  // ── AC2: Fallback reassign on exhaustion ─────────────────────────────────

  it("AC2: after retry exhaustion, reassigns delegate to ai and emits fallback signal", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:intake"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:implementation"],
    });

    // sendWakeUp always fails — every attempt
    let wakeAttempts = 0;
    const sendWakeUp = jest.fn(async (_agentId: string, _ticketId: string) => {
      wakeAttempts++;
      throw new Error("503 Service Unavailable — upstream refuses connection");
    });

    const result: SetStateAtomicResult = await setStateAtomic(
      "AI-9999", "implementation", "igor", "Bearer test-token",
      { sendWakeUp },
    );

    // AC2: Retries must be exhausted (sendWakeUp was called multiple times,
    // not just once). Current impl: called once, caught, no retry.
    expect(wakeAttempts).toBeGreaterThan(1);

    // AC2: The result must indicate the ticket was reassigned to ai (fallback).
    // Current impl: redispatched is undefined. Failing assertion.
    expect(result.redispatched).toBe("ai");

    // AC2: The set-state must still report overall success (fail-open for write).
    expect(result.ok).toBe(true);
  });

  // ── AC3: Detectability — reason code when dispatch permanently fails ─────

  it("AC3: emits reason code (session-never-spawned) when dispatch permanently fails", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:intake"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:implementation"],
    });

    const sendWakeUp = jest.fn(async () => {
      throw new Error("503 Service Unavailable");
    });

    const result: SetStateAtomicResult & { dispatchFailure?: { reasonCode: string } } = await setStateAtomic(
      "AI-9999", "implementation", "igor", "Bearer test-token",
      { sendWakeUp },
    );

    // AC3: Result must include a machine-readable reason code indicating the
    // session was never spawned, so downstream components (stall detection,
    // admin UI, alerting) can distinguish this from a healthy stamped delegate.
    // Current impl: no reason code emitted. Failing assertion.
    expect(result.dispatchFailure).toBeDefined();
    expect(result.dispatchFailure?.reasonCode).toBe("session-never-spawned");

    expect(result.ok).toBe(true);
  });

  // ── AC4: Regression — integrated scenario ────────────────────────────────

  it("AC4: simulated 503 at transition time — ticket never rests stamped-but-session-less", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:intake"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:implementation"],
    });

    // Simulate a transient 503 burst — first 3 calls fail, 4th succeeds
    let wakeAttempts = 0;
    const sendWakeUp = jest.fn(async (agentId: string, _ticketId: string) => {
      wakeAttempts++;
      if (wakeAttempts <= 3) {
        throw new Error("503 Service Unavailable — burst window");
      }
      // succeeds on 4th attempt
    });

    const result: SetStateAtomicResult = await setStateAtomic(
      "AI-9999", "implementation", "igor", "Bearer test-token",
      { sendWakeUp },
    );

    // AC4: Either the session was eventually spawned (redispatched === "igor"
    // after retry succeeds) OR the reassign fallback fired (redispatched === "ai").
    // What must NOT happen: redispatched is undefined (silent strand).
    // Current impl: redispatched is undefined — this assertion fails.
    expect(result.redispatched).toBeDefined();

    // Either outcome is acceptable per the AC:
    expect(
      (result.redispatched === "igor") || (result.redispatched === "ai"),
    ).toBe(true);

    // The set-state overall must still report success
    expect(result.ok).toBe(true);
  });

  // ── AC4 variant: Never-succeeding dispatch must end with ai reassign ─────

  it("AC4 variant: persistently failing dispatch must not strand — ends with ai reassign", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:intake"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:implementation"],
    });

    const sendWakeUp = jest.fn(async () => {
      throw new Error("503 Service Unavailable — never recovers");
    });

    const result: SetStateAtomicResult & { dispatchFailure?: { reasonCode: string } } = await setStateAtomic(
      "AI-9999", "implementation", "igor", "Bearer test-token",
      { sendWakeUp },
    );

    // Must NOT strand: after retry exhaustion, reassign to ai must fire.
    // Current impl: redispatched is undefined. Failing assertion.
    expect(result.redispatched).toBe("ai");

    // Must also emit a detectable reason code (AC3 overlap)
    expect(result.dispatchFailure).toBeDefined();
    expect(result.dispatchFailure?.reasonCode).toMatch(/session-never-spawned/);
  });
});
