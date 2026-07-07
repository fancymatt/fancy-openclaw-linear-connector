/**
 * AI-1914 — Connector: workflow-def state removal strands in-flight tickets.
 *
 * These tests are FAILING by design (TDD, test-author role). They encode the
 * acceptance criteria the implementer (Igor) must satisfy.  This file covers
 * the *new module* surface (`./def-state-migration.js`) — AC1 (migration map
 * on def change), AC3 (def validation refuses silent stranding), and the
 * AC1/AC5 auto-migrate decision logic.  AC2 (steward verb), AC4 (raw-path
 * fail-closed), and AC6 (bootstrap wiring + /health liveness) live in the
 * sibling files:
 *   - ai-1914-migrate-state-verb.test.ts   (AC2, AC5 steward-blocked)
 *   - ai-1914-raw-path-fail-closed.test.ts (AC4, AC5 raw-swap-blocked)
 *   - ai-1914-bootstrap-wiring.test.ts     (AC6)
 *
 * ── Contract this file defines (implementer builds `src/def-state-migration.ts`) ──
 *
 *   WorkflowDef gains (in workflow-gate.ts types):
 *     migrations?: Record<string, string>   // removed-state-id -> target-state-id (AC1)
 *     strand_acknowledged?: string[]         // removed state ids explicitly acked (AC3)
 *
 *   export function planDefStateMigration(
 *     labels: string[], def: WorkflowDef,
 *   ): { fromState: string; toState: string; ownerRole?: string } | null
 *     - Returns a migration plan when the ticket's `state:*` label names a state
 *       that is ABSENT from def.states but PRESENT as a key in def.migrations.
 *     - Returns null for: a valid (still-present) state; a removed state with NO
 *       mapping (that is a strand, not an auto-migration); an ungoverned ticket;
 *       or a ticket with no state:* label.
 *
 *   export async function runDefStateMigrationSweep(options): Promise<{
 *     scanned: number;
 *     migrated: Array<{ ticketId: string; identifier: string; fromState: string; toState: string }>;
 *     errors: string[];
 *   }>
 *     - Enumerates governed (wf:*) tickets, migrates each defunct-state ticket per
 *       its def.migrations map: atomic label swap + re-dispatch (wakeFn) to the
 *       target state's owner role, emitting one operational event per migration.
 *
 *   export function validateDefStateRemovals(
 *     previousStateIds: string[], nextDef: WorkflowDef,
 *   ): string[]
 *     - Returns an error per state present in previousStateIds but absent from
 *       nextDef.states that has NEITHER a def.migrations mapping NOR an entry in
 *       def.strand_acknowledged. Empty array = valid (safe to activate).
 */

import { describe, it, expect } from "@jest/globals";
import type { WorkflowDef } from "./workflow-gate.js";
import {
  planDefStateMigration,
  runDefStateMigrationSweep,
  validateDefStateRemovals,
} from "./def-state-migration.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

// dev-impl v(N+1): the `deployment` state is REMOVED and carries a migration
// mapping to `ac-validate` (the concrete AI-1857 shape). `host-deploy` is also
// removed but has NO mapping (used to prove the un-mapped / strand path).
const DEF_WITH_MIGRATION = {
  id: "dev-impl",
  version: 14,
  entry_state: "intake",
  break_glass: { command: "escape", to: "escape", owner_role: "steward" },
  migrations: { deployment: "ac-validate" },
  states: [
    { id: "intake", owner_role: "steward", native_state: "todo", transitions: [{ command: "accept", to: "implementation" }] },
    { id: "implementation", owner_role: "dev", native_state: "doing", transitions: [{ command: "submit", to: "ac-validate" }] },
    { id: "ac-validate", owner_role: "steward", native_state: "doing", transitions: [{ command: "validated", to: "done" }] },
    { id: "done", native_state: "done", transitions: [] },
    { id: "escape", native_state: "invalid", transitions: [] },
  ],
} as unknown as WorkflowDef;

// The previous def version (v(N)) — still HAS deployment + host-deploy.
const PREVIOUS_STATE_IDS = ["intake", "implementation", "deployment", "host-deploy", "ac-validate", "done", "escape"];

// ── AC1 + AC5: planDefStateMigration — auto-migrate decision on removed state ──

describe("AC1/AC5: planDefStateMigration identifies the AI-1857 shape (state in v(N), absent in v(N+1))", () => {
  it("returns a migration plan for a ticket at a removed state that has a mapping", () => {
    const plan = planDefStateMigration(["wf:dev-impl", "state:deployment"], DEF_WITH_MIGRATION);
    expect(plan).not.toBeNull();
    expect(plan!.fromState).toBe("deployment");
    expect(plan!.toState).toBe("ac-validate");
  });

  it("resolves the target's owner_role so re-dispatch reaches the target state's owner (AC1)", () => {
    const plan = planDefStateMigration(["wf:dev-impl", "state:deployment"], DEF_WITH_MIGRATION);
    // ac-validate is owned by the steward role — re-dispatch must target that owner, not deployment's.
    expect(plan!.ownerRole).toBe("steward");
  });

  it("returns null for a ticket at a state still present in the def (no migration needed)", () => {
    const plan = planDefStateMigration(["wf:dev-impl", "state:implementation"], DEF_WITH_MIGRATION);
    expect(plan).toBeNull();
  });

  it("returns null for a removed state with NO mapping (that is a strand, not an auto-migration)", () => {
    // host-deploy is absent from states AND absent from migrations → not auto-migrated.
    const plan = planDefStateMigration(["wf:dev-impl", "state:host-deploy"], DEF_WITH_MIGRATION);
    expect(plan).toBeNull();
  });

  it("returns null for an ungoverned ticket (no wf:* label)", () => {
    const plan = planDefStateMigration(["state:deployment"], DEF_WITH_MIGRATION);
    expect(plan).toBeNull();
  });

  it("returns null for a governed ticket with no state:* label", () => {
    const plan = planDefStateMigration(["wf:dev-impl"], DEF_WITH_MIGRATION);
    expect(plan).toBeNull();
  });
});

// ── AC1: runDefStateMigrationSweep — atomic swap + re-dispatch + op event ──────

describe("AC1: runDefStateMigrationSweep migrates a governed defunct-state ticket on load", () => {
  const LABEL_IDS: Record<string, string> = {
    "wf:dev-impl": "lbl-wf-dev-impl",
    "state:deployment": "lbl-state-deployment",
    "state:ac-validate": "lbl-state-ac-validate",
  };

  function makeSweepFetch(capture: {
    labelUpdateCalls: string[];
    capturedLabelIds: Map<string, string[]>;
  }): typeof globalThis.fetch {
    return (async (_url: unknown, init?: RequestInit) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      const query = parsed.query ?? "";

      // Enumerate governed (wf:*) tickets — one defunct-state ticket.
      if (query.includes("issues(") || query.includes("WorkflowIssues") || query.includes("IssueSearch")) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: "issue-1857",
                    identifier: "AI-1857",
                    updatedAt: "2026-07-07T06:00:00.000Z",
                    team: { id: "team-test" },
                    state: { name: "Doing" },
                    labels: {
                      nodes: [
                        { id: LABEL_IDS["wf:dev-impl"], name: "wf:dev-impl" },
                        { id: LABEL_IDS["state:deployment"], name: "state:deployment" },
                      ],
                    },
                    delegate: null,
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Capture the atomic label swap.
      if (query.includes("issueUpdate")) {
        const vars = (parsed.variables ?? {}) as Record<string, unknown>;
        const issId = (vars["id"] as string) ?? "";
        if (query.includes("labelIds") || vars["labelIds"]) {
          capture.labelUpdateCalls.push(issId);
          capture.capturedLabelIds.set(issId, (vars["labelIds"] as string[]) ?? []);
        }
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Team labels lookup fallback (labelNameToId is injected, so this is belt-and-suspenders).
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: Object.entries(LABEL_IDS).map(([name, id]) => ({ id, name })) } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;
  }

  it("migrates the deployment ticket to ac-validate: label swap + re-dispatch + operational event", async () => {
    const savedFetch = globalThis.fetch;
    const capture = { labelUpdateCalls: [] as string[], capturedLabelIds: new Map<string, string[]>() };
    globalThis.fetch = makeSweepFetch(capture);

    const events: Array<{ outcome?: string }> = [];
    const wakes: Array<{ agent?: string; identifier: string }> = [];
    const eventStore = {
      record: (e: { outcome?: string }) => events.push(e),
      append: (e: { outcome?: string }) => events.push(e),
    };

    try {
      const result = await runDefStateMigrationSweep({
        authToken: "Bearer tok",
        workflowRegistry: new Map([["dev-impl", DEF_WITH_MIGRATION]]),
        operationalEventStore: eventStore,
        labelNameToId: (name: string) => LABEL_IDS[name] ?? null,
        wakeFn: async (agent: string, identifier: string) => { wakes.push({ agent, identifier }); },
      });

      // AC1: the defunct-state ticket was migrated deployment -> ac-validate.
      expect(result.migrated.length).toBe(1);
      const m = result.migrated[0];
      expect(m.identifier).toBe("AI-1857");
      expect(m.fromState).toBe("deployment");
      expect(m.toState).toBe("ac-validate");

      // AC1: an atomic label swap (issueUpdate labelIds) was issued.
      expect(capture.labelUpdateCalls).toContain("issue-1857");
      // The swap drops the defunct label and adds the target label.
      const swapped = capture.capturedLabelIds.get("issue-1857") ?? [];
      expect(swapped).toContain(LABEL_IDS["state:ac-validate"]);
      expect(swapped).not.toContain(LABEL_IDS["state:deployment"]);

      // AC1: re-dispatch happened (target state owner is woken).
      expect(wakes.some((w) => w.identifier === "AI-1857")).toBe(true);

      // AC1: one operational event emitted per migrated ticket.
      expect(events.length).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("does not migrate an ungoverned ticket or a still-valid-state ticket", async () => {
    const savedFetch = globalThis.fetch;
    // Enumeration returns a ticket at a VALID state — must not be migrated.
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const query = parsed.query ?? "";
      if (query.includes("issues(") || query.includes("WorkflowIssues") || query.includes("IssueSearch")) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: "issue-live",
                    identifier: "AI-2000",
                    team: { id: "team-test" },
                    labels: { nodes: [{ id: "l1", name: "wf:dev-impl" }, { id: "l2", name: "state:implementation" }] },
                    delegate: null,
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    try {
      const result = await runDefStateMigrationSweep({
        authToken: "Bearer tok",
        workflowRegistry: new Map([["dev-impl", DEF_WITH_MIGRATION]]),
        labelNameToId: (name: string) => name,
        wakeFn: async () => {},
      });
      expect(result.migrated.length).toBe(0);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ── AC3: validateDefStateRemovals — refuse silent stranding ───────────────────

describe("AC3: def validation refuses to activate a def that removes states without a path", () => {
  it("passes when a removed state is covered by a migration mapping", () => {
    // deployment is removed but migrations:{deployment:ac-validate} covers it;
    // host-deploy is NOT in the previous set here, so no other removal to flag.
    const errors = validateDefStateRemovals(
      ["intake", "implementation", "deployment", "ac-validate", "done", "escape"],
      DEF_WITH_MIGRATION,
    );
    expect(errors).toEqual([]);
  });

  it("FAILS (non-empty errors) when a state is removed with no mapping and no strand ack", () => {
    // host-deploy is present in v(N), absent in v(N+1), unmapped, unacked → must fail.
    const errors = validateDefStateRemovals(PREVIOUS_STATE_IDS, DEF_WITH_MIGRATION);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toContain("host-deploy");
  });

  it("passes when the unmapped removed state is explicitly acknowledged via strand_acknowledged", () => {
    const acked = {
      ...DEF_WITH_MIGRATION,
      strand_acknowledged: ["host-deploy"],
    } as unknown as WorkflowDef;
    const errors = validateDefStateRemovals(PREVIOUS_STATE_IDS, acked);
    expect(errors).toEqual([]);
  });

  it("does not flag states that are unchanged or newly added", () => {
    // No removals at all → no errors.
    const errors = validateDefStateRemovals(
      ["intake", "implementation", "ac-validate", "done", "escape"],
      DEF_WITH_MIGRATION,
    );
    expect(errors).toEqual([]);
  });
});
