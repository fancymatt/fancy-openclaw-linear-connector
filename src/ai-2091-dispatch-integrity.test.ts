/**
 * AI-2091 — Connector dispatch integrity: wrong-agent / phantom / duplicate wakes.
 *
 * FAILING regression tests (TDD write-tests state). Each block below maps to a
 * clause of the AC of record captured at intake:
 *
 *   "Each child's specific repro (esp. AI-2042's canonical fixture and
 *    AI-2015's AC1–AC6) passes as a regression test. No wake is delivered to an
 *    agent with no relationship to the ticket; no wake fires on an unfetchable
 *    ticket; no single wake produces two sessions."
 *
 * Coverage map (test → AC):
 *   §1  AI-2042 canonical fixture (delegate=Astrid, armed recipient=Igor →
 *       abort+log) + summary clause "no wake to an agent with no relationship".
 *       Also the C4 stale re-poke live-ticket misroute (AI-2037: delegate=tdd,
 *       recipient=Igor).  → delivery-time recipient guard on the C4 re-poke
 *       (`staleRePokeRecipientValid`), the one delivery-time path that skipped
 *       the delegate recheck.
 *   §2  AI-2015 AC1 (fetchability verified at DELIVERY time; not-found → abort)
 *       + AC3 (phantom surfaces as an ERROR, not a warning buried in the wake)
 *       + summary clause "no wake fires on an unfetchable ticket".
 *       → NEW delivery-time fetchability gate.
 *   §3  AI-2015 AC2 — ticket deletion purges pending dispatch/mirror entries.
 *       → EnrolledTicketsStore (real code).
 *   §4  AI-2015 AC4 — watchdog arming is restart-safe (armedAt clamped to now on
 *       a cold/first arm); a stale delivered-at must not breach immediately.
 *       → runFirstActionWatchdogSweep (real code).
 *   §5  AI-2015 AC5 — an exhausted ladder fires its rung-2 side effects exactly
 *       once, INCLUDING across a restart (cold state must not re-escalate).
 *       → runFirstActionWatchdogSweep (real code).
 *   §6  AI-2015 AC6 — restart-safe backlog: the first post-restart sweep must not
 *       re-fire the entire backlog (no redispatch storm).
 *       → runFirstActionWatchdogSweep (real code).
 *   §7  Summary clause "no single wake produces two sessions" — the AI-1772
 *       intake race: one pending wake dispatched concurrently must yield exactly
 *       one delivery.  → resignalPendingTickets (real code).
 *
 * The NEW-export blocks (§1, §2) use a tolerant loader so the whole suite stays
 * collectable while the fix is unimplemented; the implementer (Igor) makes them
 * green by adding the documented delivery-time exports to src/delivery/index.ts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

import {
  runFirstActionWatchdogSweep,
  type WatchdogTicket,
  type FirstActionWatchdogOptions,
} from "./first-action-watchdog.js";
import { resetFirstActionWatchdogStateForTest } from "./first-action-watchdog-state.js";
import { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";
import { PendingWorkBag } from "./bag/pending-work-bag.js";
import { SessionTracker } from "./bag/session-tracker.js";
import { resignalPendingTickets } from "./bag/resignal.js";
import type { WakeUpConfig } from "./bag/wake-up.js";
import { reloadAgents } from "./agents.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = 1_700_000_000_000;

// ── Tolerant loader for delivery-time exports the fix must add (AI-2091) ──────
async function requireNewExport<T = (...args: unknown[]) => unknown>(
  modulePath: string,
  name: string,
): Promise<T> {
  const mod = (await import(modulePath)) as Record<string, unknown>;
  const fn = mod[name];
  if (typeof fn !== "function") {
    throw new Error(
      `AI-2091: expected a delivery-time export \`${name}\` from ${modulePath} — ` +
        `not implemented yet. The dispatch-integrity fix must add it.`,
    );
  }
  return fn as T;
}

// ════════════════════════════════════════════════════════════════════════════
// §1 — Wrong-agent dispatch. AI-2042 canonical fixture + "no wake to an agent
//      with no relationship to the ticket". Recipient must be resolved from the
//      ticket's CURRENT delegate at delivery time; a wake armed for a
//      non-delegate is aborted, never delivered.
// ════════════════════════════════════════════════════════════════════════════

type StaleRePokeGuard = (
  sessionKey: string,
  agentId: string,
  check?: (sessionKey: string, agentId: string, routingReason: "delegate") => Promise<boolean>,
) => Promise<boolean>;

async function loadStaleRePokeGuard(): Promise<StaleRePokeGuard> {
  // The guard is added to src/index.ts by the fix; red until then.
  return requireNewExport<StaleRePokeGuard>("./index.js", "staleRePokeRecipientValid");
}

// Mock the current Linear ticket the delegate recheck reads.
function mockIssue(issue: unknown): void {
  global.fetch = jest
    .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
    .mockResolvedValue({
      ok: true,
      json: async () => ({ data: { issue } }),
    } as unknown as Response) as unknown as typeof fetch;
}

describe("§1 delivery-time recipient guard on the C4 re-poke (AI-2042 canonical)", () => {
  const IGOR_ID = "u-igor";
  const ASTRID_ID = "u-astrid";
  const TDD_ID = "u-tdd";
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  let agentsDir: string;

  beforeEach(() => {
    // Agents need resolvable linearUserId + token so the delegate recheck
    // verifies identity instead of short-circuiting to allow-through.
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2091-agents-"));
    const agentsFile = path.join(agentsDir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          { name: "igor", linearUserId: IGOR_ID, openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
          { name: "astrid", linearUserId: ASTRID_ID, openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
          { name: "tdd", linearUserId: TDD_ID, openclawAgent: "tdd", accessToken: "tok-tdd", host: "local" },
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

  it("AI-2042/AI-1774 canonical: delegate=Astrid, armed recipient=Igor → drop (no wake to Igor)", async () => {
    const guard = await loadStaleRePokeGuard();
    mockIssue({
      id: "issue-1774",
      identifier: "AI-1774",
      delegate: { id: ASTRID_ID, name: "Astrid (CPO)" },
      assignee: null,
      state: { name: "Backlog", type: "backlog" },
      relations: { nodes: [] },
    });

    await expect(guard("linear-AI-1774", "igor")).resolves.toBe(false);
  });

  it("C4 re-poke on a LIVE ticket (AI-2037: delegate=tdd, armed=Igor) → drop", async () => {
    const guard = await loadStaleRePokeGuard();
    // An existence check alone would not catch this — only a delegate-binding check.
    mockIssue({
      id: "issue-2037",
      identifier: "AI-2037",
      delegate: { id: TDD_ID, name: "TestDrivenDevelopmentAgent" },
      assignee: null,
      state: { name: "Doing", type: "started" },
      relations: { nodes: [] },
    });

    await expect(guard("linear-AI-2037", "igor")).resolves.toBe(false);
  });

  it("re-pokes when the stale agent is still the current delegate", async () => {
    const guard = await loadStaleRePokeGuard();
    mockIssue({
      id: "issue-2037",
      identifier: "AI-2037",
      delegate: { id: IGOR_ID, name: "Igor (Back End Dev)" },
      assignee: null,
      state: { name: "Doing", type: "started" },
      relations: { nodes: [] },
    });

    await expect(guard("linear-AI-2037", "igor")).resolves.toBe(true);
  });

  it("delegate cleared (handed back / needs-human) → drop, never coalesce to the armed agent", async () => {
    const guard = await loadStaleRePokeGuard();
    mockIssue({
      id: "issue-2052",
      identifier: "AI-2052",
      delegate: null,
      assignee: null,
      state: { name: "Todo", type: "unstarted" },
      relations: { nodes: [] },
    });

    await expect(guard("linear-AI-2052", "igor")).resolves.toBe(false);
  });

  it("phantom ticket (no longer exists) → drop", async () => {
    const guard = await loadStaleRePokeGuard();
    mockIssue(null);

    await expect(guard("linear-AI-9999", "igor")).resolves.toBe(false);
  });

  it("recipient is resolved via the DELEGATE routing reason, consulted once", async () => {
    const guard = await loadStaleRePokeGuard();
    const check = jest
      .fn<(s: string, a: string, r: "delegate") => Promise<boolean>>()
      .mockResolvedValue(false);

    await expect(guard("linear-AI-1774", "igor", check)).resolves.toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith("linear-AI-1774", "igor", "delegate");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §2 — Phantom dispatch. AI-2015 AC1/AC3 + "no wake fires on an unfetchable
//      ticket". The fetchability check runs at DELIVERY time; a terminal
//      not-found aborts the dispatch and surfaces as an ERROR (not a warning
//      buried inside the wake message).
// ════════════════════════════════════════════════════════════════════════════

describe("§2 delivery-time fetchability gate (AI-2015 AC1/AC3)", () => {
  it("unfetchable ticket (not-found at delivery) → dispatch aborts, no wake", async () => {
    const assertDispatchTargetFetchable = await requireNewExport(
      "./delivery/index.js",
      "assertDispatchTargetFetchable",
    );

    // AI-2014 was deleted; `observe-issue` returns "Issue not found" and is not
    // transient. The gate must abort rather than dispatch "workflow context
    // unavailable".
    const decision = (await assertDispatchTargetFetchable({
      ticketId: "AI-2014",
      fetchable: false,
      terminalNotFound: true,
    })) as { dispatch: boolean; severity: string };

    expect(decision.dispatch).toBe(false);
    // AC3: surfaced as an error, not a warning.
    expect(decision.severity).toBe("error");
  });

  it("distinguishes a transient fetch error from a terminal not-found (does not hard-abort on transient)", async () => {
    const assertDispatchTargetFetchable = await requireNewExport(
      "./delivery/index.js",
      "assertDispatchTargetFetchable",
    );

    const decision = (await assertDispatchTargetFetchable({
      ticketId: "AI-2014",
      fetchable: false,
      terminalNotFound: false, // transient (5xx / timeout)
    })) as { dispatch: boolean; severity: string };

    // A transient error is not a phantom ticket — it must not be classified as
    // the AC3 hard error (fail-open / retry, not a swallowed phantom).
    expect(decision.severity).not.toBe("error");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §3 — AI-2015 AC2: ticket deletion (or move out of an enrolled team) purges
//      pending dispatch/queue entries from the enrolled-tickets mirror.
// ════════════════════════════════════════════════════════════════════════════

describe("§3 mirror purge on deletion (AI-2015 AC2)", () => {
  let dir: string;
  let store: EnrolledTicketsStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2091-mirror-"));
    store = new EnrolledTicketsStore(path.join(dir, "enrolled.db"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("purge() removes the row so the watchdog data plane no longer sees the deleted ticket", () => {
    store.enroll({ ticketId: "AI-2014", workflow: "dev-impl", state: "intake", delegate: "astrid" });
    expect(store.getByTicketId("AI-2014")).not.toBeNull();

    // Deletion must PURGE, not merely flag terminal — a terminal-but-present row
    // still feeds the watchdog listTickets() data plane and drives phantom wakes.
    const purge = (store as unknown as { purge?: (id: string) => unknown }).purge;
    expect(typeof purge).toBe("function");
    (purge as (id: string) => unknown).call(store, "AI-2014");

    expect(store.getByTicketId("AI-2014")).toBeNull();
    expect(store.getAll().some((r) => r.ticket_id === "AI-2014")).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §4–§6 — Watchdog restart-safety (AI-2015 AC4/AC5/AC6).
// ════════════════════════════════════════════════════════════════════════════

const WORKFLOW_DEF_YAML = `
id: dev-impl
name: Dev Implementation
initial: write-tests
states:
  - id: write-tests
    owner_role: test-author
    first_action_deadline: 45m
  - id: intake
    owner_role: steward
`;

let wdDir: string;
let workflowDefPath: string;

function ticket(overrides: Partial<WatchdogTicket> = {}): WatchdogTicket {
  return {
    ticket: "AI-2014",
    workflow: "dev-impl",
    state: "intake",
    delegate: "astrid",
    humanAssigned: false,
    labels: ["wf:dev-impl", "state:intake"],
    dispatchDeliveredAtMs: T0,
    dispatchUpdatedAt: new Date(T0).toISOString(),
    firstOwnerActionAtMs: null,
    ...overrides,
  };
}

function makeOpts(
  tickets: WatchdogTicket[],
  overrides: Partial<FirstActionWatchdogOptions> = {},
) {
  const redispatch = jest.fn(async (_d: unknown) => ({ admitted: true }));
  const escalateUnreachable = jest.fn(async (_d: unknown) => undefined);
  const notify = jest.fn((_a: unknown) => undefined);
  const opts: FirstActionWatchdogOptions = {
    workflowDefPath,
    listTickets: async () => tickets,
    now: () => T0,
    defaultDeadlineMs: 30 * MINUTE,
    maxRungs: 3,
    notify,
    redispatch,
    escalateUnreachable,
    ...overrides,
  };
  return { opts, spies: { redispatch, escalateUnreachable, notify } };
}

describe("§4–6 watchdog restart-safety (AI-2015 AC4/AC5/AC6)", () => {
  beforeEach(() => {
    wdDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2091-watchdog-"));
    workflowDefPath = path.join(wdDir, "dev-impl.yaml");
    fs.writeFileSync(workflowDefPath, WORKFLOW_DEF_YAML, "utf8");
    resetFirstActionWatchdogStateForTest();
  });

  afterEach(() => {
    fs.rmSync(wdDir, { recursive: true, force: true });
  });

  // §4 — AC4: a cold/first arm clamps armedAt to now; a stale delivered-at (from
  //      before a restart/deletion) must not breach on the very first sweep.
  it("AC4: stale delivered-at on a cold ladder does not breach on the first sweep (armedAt clamped to now)", async () => {
    // Delivered 10h ago, deadline 30m — with no clamp this breaches immediately
    // on the first post-restart sweep, re-firing a dead backlog.
    const t = ticket({ dispatchDeliveredAtMs: T0 - 10 * HOUR, firstOwnerActionAtMs: null });
    const { opts, spies } = makeOpts([t]); // now() === T0, cold state

    const r = await runFirstActionWatchdogSweep(opts);

    expect(r.breached).toBe(0);
    expect(r.redispatched).toBe(0);
    expect(spies.redispatch).not.toHaveBeenCalled();
  });

  // §5 — AC5: an exhausted ladder fires rung-2 exactly once — including across a
  //      restart (cold in-memory state must not resurrect and re-escalate).
  it("AC5: an already-exhausted ladder does not re-escalate on the first sweep after a restart", async () => {
    // Pre-restart this ladder exhausted its rungs (rungsFired == maxRungs) and
    // fired its single rung-2 alert. After a restart (cold state) it must stay
    // silent, not fire the "delegate unreachable" alert again.
    const t = ticket({ rungsFired: 3, dispatchDeliveredAtMs: T0 - 10 * HOUR });
    const { opts, spies } = makeOpts([t]);

    const r = await runFirstActionWatchdogSweep(opts);

    expect(spies.escalateUnreachable).not.toHaveBeenCalled();
    expect(spies.notify).not.toHaveBeenCalled();
    expect(r.unreachable).toBe(0);
  });

  // §6 — AC6: restart-safe backlog — the first post-restart sweep must not
  //      re-fire the whole backlog (no redispatch storm).
  it("AC6: the first post-restart sweep over a stale backlog fires zero redispatches", async () => {
    const backlog = [
      ticket({ ticket: "AI-9001", dispatchDeliveredAtMs: T0 - 10 * HOUR }),
      ticket({ ticket: "AI-9002", dispatchDeliveredAtMs: T0 - 9 * HOUR }),
      ticket({ ticket: "AI-9003", dispatchDeliveredAtMs: T0 - 8 * HOUR }),
    ];
    const { opts, spies } = makeOpts(backlog);

    const r = await runFirstActionWatchdogSweep(opts);

    expect(r.redispatched).toBe(0);
    expect(spies.redispatch).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §7 — Duplicate session dispatch. "No single wake produces two sessions." The
//      AI-1772 intake race: one pending ticket dispatched concurrently must
//      deliver exactly one wake (wake→session idempotency on the dispatch path).
// ════════════════════════════════════════════════════════════════════════════

describe("§7 one wake → one session (AI-1774 / AI-1772 intake race)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2091-dedup-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("concurrent dispatch of a single pending wake delivers exactly one wake", async () => {
    const bag = new PendingWorkBag(path.join(dir, "bag.db"));
    const tracker = new SessionTracker();
    bag.add("igor", "AI-1774", "Issue");

    const sendWakeUp = jest.fn(async () => ({ runId: "run-1" }));
    const wakeConfig = {} as WakeUpConfig;
    const options = {
      isTicketActionable: () => true,
      sendWakeUp,
      markActive: true,
    };

    // Two concurrent dispatches for the same single Linear wake (intake race).
    await Promise.all([
      resignalPendingTickets("igor", ["AI-1774"], bag, tracker, wakeConfig, options),
      resignalPendingTickets("igor", ["AI-1774"], bag, tracker, wakeConfig, options),
    ]);

    // Exactly one session for one wake — no twin-session fan-out.
    expect(sendWakeUp).toHaveBeenCalledTimes(1);
  });
});
