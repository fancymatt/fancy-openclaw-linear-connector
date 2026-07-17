/**
 * AI-2543: the AI-2176 inherited-label fallback borrows the PARENT team's label
 * id, which Linear rejects on `issueUpdate`, so every governed transition on a
 * sub-team with inherited `state:*` labels fails the atomic write.
 *
 * Live incident (Grover, AGI-6 / LIF-35 / LIF-31, 2026-07-17 00:22–00:28Z),
 * confirmed against b33e23e:
 *   1. Sub-team LIF tries to create `state:product-definition`.
 *   2. Linear rejects: "conflicting inherited label" — parent team GEN owns it.
 *   3. The fallback searches other org teams and returns GEN's label id.
 *   4. The atomic issueUpdate (labelIds + delegateId + stateId) is rejected 3×
 *      → `transition write FAILED`.
 *
 * The assumption in the current code comment (workflow-gate.ts:1219) is false:
 *   "The inherited label's ID is still usable for issue mutations on the sub-team."
 * Linear rejects a parent-owned label id in `labelIds` on a child-team issue and
 * names the remedy in its own error text: use `replaceTeamLabels` to promote the
 * label to this team.
 *
 * The fallback is DUPLICATED — both sites are in scope:
 *   SITE 1  src/workflow-gate.ts:1108  findOrCreateLabel  (module-private; governed transitions)
 *   SITE 2  src/linear-helpers.ts:45   findOrCreateLabel  (exported; barrier/review path)
 *
 * AC mapping (verbatim AC of record, captured at intake 2026-07-17T00:43:35.743Z):
 *   AC1 — On `conflicting inherited label`, the label is promoted to the
 *         requesting team and the returned id is one the sub-team owns.
 *   AC2 — A governed transition on a LIF ticket with inherited `state:*` labels
 *         completes the atomic write (labels + delegate + native state).
 *   AC3 — Both implementations fixed; behavior stays identical for teams that
 *         own their labels directly (AI-team path unchanged).
 *   AC4 — Regression coverage for the inherited-conflict → promote → usable-id path.
 *
 * ── How these tests are built ────────────────────────────────────────────────
 * The mock is a small FAKE LINEAR with a real label-ownership registry, not a
 * canned script of responses. It enforces the two server behaviors that define
 * this bug:
 *   (a) `issueLabelCreate` for a name an ancestor team owns fails with
 *       "conflicting inherited label" UNLESS `replaceTeamLabels: true` is sent,
 *       in which case the label is PROMOTED to the requesting team and a
 *       team-owned id is returned.
 *   (b) `issueUpdate` REJECTS any labelId whose owning team is not the issue's
 *       own team. This is the server behavior that makes the borrowed id fatal.
 * Assertions are therefore on OUTCOME — "is the returned id owned by the
 * requesting team?" — not on a prescribed call sequence. Any correct promotion
 * mechanism satisfies them; the fix is not dictated by the test.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { findOrCreateLabel, issueUpdateLabels } from "./linear-helpers.js";
import { resetWorkflowCache, _setTransitionWritePolicyForTests } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";

// ── Real ids from the incident ───────────────────────────────────────────────

/** LIF / Life OS — the sub-team whose transitions are blocked. */
const LIF_TEAM = "cf350b07-bdd4-48e4-8e58-27f336178738";
/** GEN / Creative Generation — the parent team that owns the inherited labels. */
const GEN_TEAM = "59e95050-32c3-478b-a7a1-41f5077d95de";
/** AI team — owns its `state:*` labels directly; the no-regression control. */
const AI_TEAM = "ai-team-uuid";

const AUTH = "Bearer test-token";

// ── Fake Linear ──────────────────────────────────────────────────────────────

interface FakeLabel {
  id: string;
  name: string;
  /** The team that OWNS this label. Ownership is what Linear enforces. */
  teamId: string;
}

interface FakeIssue {
  internalId: string;
  identifier: string;
  teamId: string;
  labelIds: string[];
  delegateId: string | null;
  stateId: string | null;
}

interface FakeLinearOpts {
  /** Seed labels. */
  labels: FakeLabel[];
  /** Team ids the org exposes via the `OrgTeams` query. */
  teams: string[];
  /** The issue under test, when the test drives a governed transition. */
  issue?: FakeIssue;
  /** Force the promotion (`replaceTeamLabels: true`) create to fail — fail-closed path. */
  promotionFails?: boolean;
  /** Native workflow states returned by `TeamStates`. */
  states?: Array<{ id: string; name: string; type: string }>;
}

interface FakeLinear {
  fetch: typeof globalThis.fetch;
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
  labels: FakeLabel[];
  issue?: FakeIssue;
  /** Ownership lookup — the contract these tests assert on. */
  ownerOf: (labelId: string) => string | undefined;
  /** Every issueUpdate rejection the fake produced, for diagnosis. */
  rejections: string[];
}

const DEFAULT_STATES = [
  { id: "s-todo", name: "Todo", type: "unstarted" },
  { id: "s-doing", name: "Doing", type: "started" },
  { id: "s-done", name: "Done", type: "completed" },
];

function makeFakeLinear(opts: FakeLinearOpts, passthrough: typeof globalThis.fetch): FakeLinear {
  const labels = [...opts.labels];
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const rejections: string[] = [];
  const issue = opts.issue;
  let promotedSeq = 0;

  const json = (payload: object) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const ownerOf = (labelId: string) => labels.find((l) => l.id === labelId)?.teamId;

  const fetchImpl: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      return passthrough(url, init);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const q = parsed.query ?? "";
    const vars = parsed.variables ?? {};
    calls.push({ query: q, variables: vars });

    // NOTE: dispatch on the full `query <Name>` prefix, not a bare substring —
    // "OtherTeamLabels" and "replaceTeamLabels" both contain "TeamLabels".

    // ── The fallback's org-wide sweep ──
    if (q.includes("query OrgTeams")) {
      return json({ data: { teams: { nodes: opts.teams.map((id) => ({ id })) } } });
    }
    if (q.includes("query OtherTeamLabels")) {
      const tid = vars.tid as string;
      const nodes = labels.filter((l) => l.teamId === tid).map((l) => ({ id: l.id, name: l.name }));
      return json({ data: { team: { labels: { nodes } } } });
    }

    // ── Label lookup for a team (both twins name this query `TeamLabels`) ──
    if (q.includes("query TeamLabels")) {
      const teamId = vars.teamId as string;
      const nodes = labels
        .filter((l) => l.teamId === teamId)
        .map((l) => ({ id: l.id, name: l.name, isGroup: false, parent: null }));
      return json({ data: { team: { labels: { nodes } } } });
    }

    // ── issueLabelCreate: the inherited-conflict + promotion surface ──
    if (q.includes("issueLabelCreate")) {
      const teamId = vars.teamId as string;
      const name = vars.name as string;
      // Linear's `replaceTeamLabels` is an argument on issueLabelCreate. Accept it
      // either as a GraphQL variable or inlined literally in the mutation text, so
      // the fix is free to wire it whichever way reads best.
      const wantsPromotion =
        vars.replaceTeamLabels === true || /replaceTeamLabels\s*:\s*true/.test(q);

      const conflicting = labels.find((l) => l.name === name && l.teamId !== teamId);

      if (conflicting && !wantsPromotion) {
        // (a) The exact rejection from the incident.
        return json({
          errors: [
            {
              message:
                `conflicting inherited label: '${name}' is inherited from another team; ` +
                `use replaceTeamLabels to promote the label to this team`,
            },
          ],
          data: { issueLabelCreate: null },
        });
      }

      if (conflicting && wantsPromotion) {
        if (opts.promotionFails) {
          return json({
            errors: [{ message: "promotion refused by server" }],
            data: { issueLabelCreate: null },
          });
        }
        // Promotion: the label becomes owned by the REQUESTING team.
        const promotedId = `lbl-promoted-${++promotedSeq}`;
        labels.splice(labels.indexOf(conflicting), 1);
        labels.push({ id: promotedId, name, teamId });
        return json({ data: { issueLabelCreate: { success: true, issueLabel: { id: promotedId } } } });
      }

      // No conflict — ordinary create, owned by the requesting team.
      const createdId = `lbl-created-${++promotedSeq}`;
      labels.push({ id: createdId, name, teamId });
      return json({ data: { issueLabelCreate: { success: true, issueLabel: { id: createdId } } } });
    }

    // ── B1 context fetch ──
    if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels")) {
      if (!issue) return json({ data: { issue: null } });
      return json({
        data: {
          issue: {
            labels: { nodes: issue.labelIds.map((id) => ({ name: labels.find((l) => l.id === id)?.name })) },
            delegate: issue.delegateId ? { id: issue.delegateId } : null,
          },
        },
      });
    }

    // ── B2 transition fetch ──
    if (q.includes("IssueWithLabels")) {
      if (!issue) return json({ data: { issue: null } });
      return json({
        data: {
          issue: {
            id: issue.internalId,
            identifier: issue.identifier,
            team: { id: issue.teamId },
            labels: {
              nodes: issue.labelIds.map((id) => ({ id, name: labels.find((l) => l.id === id)?.name })),
            },
          },
        },
      });
    }

    if (q.includes("TeamStates")) {
      return json({ data: { team: { states: { nodes: opts.states ?? DEFAULT_STATES } } } });
    }

    // ── Read-after-write verification (AI-1762) ──
    if (q.includes("VerifyTransitionWrite")) {
      if (!issue) return json({ data: { issue: null } });
      return json({
        data: {
          issue: {
            labels: { nodes: issue.labelIds.map((id) => ({ name: labels.find((l) => l.id === id)?.name })) },
            delegate: issue.delegateId ? { id: issue.delegateId } : null,
            state: issue.stateId ? { id: issue.stateId } : null,
          },
        },
      });
    }

    // ── issueUpdate: enforces label ownership. This is the crux. ──
    if (q.includes("issueUpdate")) {
      const targetIssue = issue;
      // The proxy forwards the agent's own mutation verbatim before applying the
      // transition; that pass-through carries no labelIds and must NOT be treated
      // as a label write (doing so wipes the issue's labels and the ticket then
      // reads as ad-hoc).
      if (vars.labelIds === undefined) {
        return json({
          data: { issueUpdate: { success: true, issue: { id: targetIssue?.internalId ?? "issue-uuid" } } },
        });
      }
      const labelIds = vars.labelIds as string[];
      if (targetIssue) {
        // (b) Linear rejects a label id owned by a team other than the issue's.
        const foreign = labelIds.filter((id) => {
          const owner = ownerOf(id);
          return owner !== undefined && owner !== targetIssue.teamId;
        });
        if (foreign.length > 0) {
          const detail = foreign
            .map((id) => `${labels.find((l) => l.id === id)?.name ?? id} (owned by team ${ownerOf(id)})`)
            .join(", ");
          const msg = `label ids not available on team ${targetIssue.teamId}: ${detail}`;
          rejections.push(msg);
          return json({ errors: [{ message: msg }], data: { issueUpdate: { success: false } } });
        }
        // Accepted — persist so read-after-write verification can see it.
        targetIssue.labelIds = labelIds;
        if (vars.delegateId !== undefined) targetIssue.delegateId = vars.delegateId as string | null;
        if (vars.stateId !== undefined) targetIssue.stateId = vars.stateId as string | null;
      }
      return json({ data: { issueUpdate: { success: true, issue: { id: targetIssue?.internalId ?? "issue-uuid" } } } });
    }

    return json({ data: {} });
  };

  return { fetch: fetchImpl, calls, labels, issue, ownerOf, rejections };
}

// ═════════════════════════════════════════════════════════════════════════════
// SITE 2 — src/linear-helpers.ts findOrCreateLabel (exported; barrier/review)
// ═════════════════════════════════════════════════════════════════════════════

describe("AI-2543 SITE 2 — linear-helpers.findOrCreateLabel inherited-label promotion", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** LIF owns nothing named `state:product-definition`; GEN owns it (inherited). */
  function inheritedConflictFixture() {
    return makeFakeLinear(
      {
        teams: [LIF_TEAM, GEN_TEAM],
        labels: [
          { id: "lbl-lif-wf", name: "wf:dev-impl", teamId: LIF_TEAM },
          { id: "lbl-gen-pd", name: "state:product-definition", teamId: GEN_TEAM },
        ],
        issue: {
          internalId: "lif-issue-uuid",
          identifier: "LIF-35",
          teamId: LIF_TEAM,
          labelIds: ["lbl-lif-wf"],
          delegateId: null,
          stateId: "s-todo",
        },
      },
      originalFetch,
    );
  }

  it("AC1: on 'conflicting inherited label', returns an id OWNED BY the requesting sub-team — not the parent's borrowed id", async () => {
    const fake = inheritedConflictFixture();
    globalThis.fetch = fake.fetch;

    const id = await findOrCreateLabel(LIF_TEAM, "state:product-definition", AUTH);

    expect(id).not.toBeNull();
    // The bug: today this returns GEN's id ("lbl-gen-pd").
    expect(id).not.toBe("lbl-gen-pd");
    // The AC: the returned id must be one the requesting sub-team owns.
    expect(fake.ownerOf(id!)).toBe(LIF_TEAM);
  });

  it("AC4: the promoted id is then ACCEPTED in an issueUpdate labelIds write (inherited-conflict → promote → usable-id)", async () => {
    const fake = inheritedConflictFixture();
    globalThis.fetch = fake.fetch;

    const id = await findOrCreateLabel(LIF_TEAM, "state:product-definition", AUTH);
    expect(id).not.toBeNull();

    // The full round trip: the resolved id must survive a real label write on the
    // sub-team's issue. A borrowed parent id is rejected here — that is the bug.
    const ok = await issueUpdateLabels("lif-issue-uuid", ["lbl-lif-wf", id!], AUTH);

    expect(fake.rejections).toEqual([]);
    expect(ok).toBe(true);
  });

  it("AC1 (fail-closed): when promotion itself fails, returns null rather than silently borrowing the parent id", async () => {
    const fake = makeFakeLinear(
      {
        teams: [LIF_TEAM, GEN_TEAM],
        labels: [{ id: "lbl-gen-pd", name: "state:product-definition", teamId: GEN_TEAM }],
        promotionFails: true,
      },
      originalFetch,
    );
    globalThis.fetch = fake.fetch;

    const id = await findOrCreateLabel(LIF_TEAM, "state:product-definition", AUTH);

    // Never hand back an id the sub-team cannot use — that is what produced the
    // 3× rejected atomic write instead of a clean, diagnosable failure.
    expect(id).not.toBe("lbl-gen-pd");
    expect(id).toBeNull();
  });

  // ── AC3 no-regression control: this SHOULD pass today and must keep passing ──

  it("AC3 (no-regression): a team that owns its label directly resolves with NO create, NO fallback, NO promotion", async () => {
    const fake = makeFakeLinear(
      {
        teams: [AI_TEAM, GEN_TEAM],
        labels: [{ id: "lbl-ai-impl", name: "state:implementation", teamId: AI_TEAM }],
      },
      originalFetch,
    );
    globalThis.fetch = fake.fetch;

    const id = await findOrCreateLabel(AI_TEAM, "state:implementation", AUTH);

    expect(id).toBe("lbl-ai-impl");
    expect(fake.calls.some((c) => c.query.includes("issueLabelCreate"))).toBe(false);
    expect(fake.calls.some((c) => c.query.includes("OrgTeams"))).toBe(false);
    expect(fake.calls.some((c) => /replaceTeamLabels/.test(c.query))).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SITE 1 — src/workflow-gate.ts findOrCreateLabel (module-private)
//
// Driven through the public proxy surface (createApp + supertest) rather than
// imported: the twin is not exported, and exporting it would be an
// implementation change. This is also exactly what AC2 asks for — a real
// governed transition completing its atomic write.
// ═════════════════════════════════════════════════════════════════════════════

const POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

// `dev` is a MULTI-body role, so the transition carries an explicit --target and
// the atomic write must set all three facets: labels + delegate + native state.
const WORKFLOW_YAML = `
id: dev-impl
version: 9
archetype: single-task
entry_state: intake
break_glass:
  command: escape
  to: intake
  owner_role: steward
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
    native_state: doing
    transitions:
      - command: submit
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "charles", linearUserId: "u-charles", openclawAgent: "charles", accessToken: "tok1", host: "local" },
        { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok2", host: "local" },
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok3", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

describe("AI-2543 SITE 1 — governed transition on a sub-team with inherited state:* labels", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ai2543-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(wfFile, WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    // Keep the AI-1762 bounded retry from adding real sleep to the red path.
    _setTransitionWritePolicyForTests({ retryDelayMs: 0 });
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTransitionWritePolicyForTests();
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  /**
   * A LIF ticket in `state:intake`, accepted into `implementation`.
   *
   * The destination label `state:implementation` is the one that hits the
   * inherited conflict — GEN owns it, LIF does not. The labels the issue already
   * carries are LIF-owned, which isolates the failure to the create → conflict →
   * fallback path from the incident's Mechanism section (steps 1–4): the atomic
   * write is rejected ONLY because the destination label id was borrowed.
   */
  function lifFixture() {
    return makeFakeLinear(
      {
        teams: [LIF_TEAM, GEN_TEAM],
        labels: [
          { id: "lbl-lif-wf", name: "wf:dev-impl", teamId: LIF_TEAM },
          { id: "lbl-lif-intake", name: "state:intake", teamId: LIF_TEAM },
          // Inherited from the parent team — the source of the conflict.
          { id: "lbl-gen-impl", name: "state:implementation", teamId: GEN_TEAM },
        ],
        issue: {
          internalId: "lif-issue-uuid",
          identifier: "LIF-35",
          teamId: LIF_TEAM,
          labelIds: ["lbl-lif-wf", "lbl-lif-intake"],
          delegateId: "u-astrid",
          stateId: "s-todo",
        },
      },
      originalFetch,
    );
  }

  function acceptToImplementation() {
    return request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", AUTH)
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "accept")
      .set("X-Openclaw-Linear-Target", "igor")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "lif-issue-uuid" },
      });
  }

  it("AC2: a LIF governed transition completes the atomic write — labels + delegate + native state", async () => {
    const fake = lifFixture();
    globalThis.fetch = fake.fetch;

    const res = await acceptToImplementation();

    expect(res.status).toBe(200);
    // Today: the fallback borrows GEN's `lbl-gen-impl`, the fake rejects it exactly
    // as Linear does, and the write fails after the bounded retry.
    expect(fake.rejections).toEqual([]);
    expect(res.body._workflowTransition).toBeDefined();
    expect(res.body._workflowTransition.status).toBe("applied");
    expect(res.body._workflowTransition.to).toBe("implementation");
  });

  it("AC1+AC2: the destination label id sent in the atomic write is owned by LIF, not borrowed from GEN", async () => {
    const fake = lifFixture();
    globalThis.fetch = fake.fetch;

    await acceptToImplementation();

    const atomic = fake.calls.find((c) => c.query.includes("ApplyAtomicTransition"));
    expect(atomic).toBeDefined();
    const vars = atomic!.variables as {
      issueId: string;
      labelIds: string[];
      delegateId?: string;
      stateId?: string;
    };

    // Every label id in the write must belong to the issue's own team.
    for (const id of vars.labelIds) {
      expect(fake.ownerOf(id)).toBe(LIF_TEAM);
    }
    expect(vars.labelIds).not.toContain("lbl-gen-impl"); // the borrowed parent id
    expect(vars.labelIds).not.toContain("lbl-lif-intake"); // stale state label stripped
    expect(vars.delegateId).toBe("u-igor");
    expect(vars.stateId).toBe("s-doing");
  });

  it("AC4: the atomic write is verified as fully persisted (no 3× rejection → transition write FAILED)", async () => {
    const fake = lifFixture();
    globalThis.fetch = fake.fetch;

    await acceptToImplementation();

    // The incident's signature was the same mutation rejected 3× by the retry loop.
    const atomicCalls = fake.calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
    expect(atomicCalls.length).toBe(1);

    // …and the facets actually landed on the issue.
    const landed = fake.issue!;
    const landedNames = landed.labelIds.map((id) => fake.labels.find((l) => l.id === id)?.name);
    expect(landedNames).toContain("state:implementation");
    expect(landed.delegateId).toBe("u-igor");
    expect(landed.stateId).toBe("s-doing");
  });

  /**
   * AI-2543 diagnostic contract (raised by Ai on the ticket, 2026-07-17T00:46Z,
   * corroborated from AGI-5): the fallback is also what MASKED this failure. By
   * returning a foreign id instead of null it sends the caller on to the atomic
   * write, so an unresolvable label surfaces as `atomic-mutation-failed`
   * (mutation-class) instead of the self-describing `label-resolve-failed`
   * (label-resolve-class, workflow-gate.ts:3658). That single swap is why this
   * was chased first as an artifact-gate bug and then as AI-2532. Without this
   * pin the next occurrence is just as opaque even after AI-2544 lands.
   */
  it("AC1 (fail-closed): an unresolvable inherited conflict fails label-resolve-class, NOT mutation-class", async () => {
    const fake = makeFakeLinear(
      {
        teams: [LIF_TEAM, GEN_TEAM],
        labels: [
          { id: "lbl-lif-wf", name: "wf:dev-impl", teamId: LIF_TEAM },
          { id: "lbl-lif-intake", name: "state:intake", teamId: LIF_TEAM },
          { id: "lbl-gen-impl", name: "state:implementation", teamId: GEN_TEAM },
        ],
        promotionFails: true,
        issue: {
          internalId: "lif-issue-uuid",
          identifier: "LIF-35",
          teamId: LIF_TEAM,
          labelIds: ["lbl-lif-wf", "lbl-lif-intake"],
          delegateId: "u-astrid",
          stateId: "s-todo",
        },
      },
      originalFetch,
    );
    globalThis.fetch = fake.fetch;

    const res = await acceptToImplementation();

    expect(res.body._workflowTransition).toBeDefined();
    expect(res.body._workflowTransition.status).toBe("failed");
    // Today: the borrowed id reaches the atomic write and this reads
    // "atomic-mutation-failed" — the opacity that misrouted the investigation.
    expect(res.body._workflowTransition.code).toBe("label-resolve-failed");
    // An unusable label id must never reach the write at all.
    expect(fake.calls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(false);
  });

  // ── AC3 no-regression control: this SHOULD pass today and must keep passing ──

  it("AC3 (no-regression): an AI-team transition that owns its labels never enters the fallback or promotion path", async () => {
    const fake = makeFakeLinear(
      {
        teams: [AI_TEAM, GEN_TEAM],
        labels: [
          { id: "lbl-ai-wf", name: "wf:dev-impl", teamId: AI_TEAM },
          { id: "lbl-ai-intake", name: "state:intake", teamId: AI_TEAM },
          { id: "lbl-ai-impl", name: "state:implementation", teamId: AI_TEAM },
        ],
        issue: {
          internalId: "ai-issue-uuid",
          identifier: "AI-2543",
          teamId: AI_TEAM,
          labelIds: ["lbl-ai-wf", "lbl-ai-intake"],
          delegateId: "u-astrid",
          stateId: "s-todo",
        },
      },
      originalFetch,
    );
    globalThis.fetch = fake.fetch;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", AUTH)
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "accept")
      .set("X-Openclaw-Linear-Target", "igor")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "ai-issue-uuid" },
      });

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition.status).toBe("applied");

    // The AI path owns its labels: no create, no org sweep, no promotion.
    expect(fake.calls.some((c) => c.query.includes("issueLabelCreate"))).toBe(false);
    expect(fake.calls.some((c) => c.query.includes("OrgTeams"))).toBe(false);
    expect(fake.calls.some((c) => /replaceTeamLabels/.test(c.query))).toBe(false);

    const atomic = fake.calls.find((c) => c.query.includes("ApplyAtomicTransition"));
    expect(atomic).toBeDefined();
    expect((atomic!.variables as { labelIds: string[] }).labelIds).toContain("lbl-ai-impl");
  });
});
