/**
 * AI-2041 (P4-C6) — Dev-impl learning-loop pilot, end to end on real infra.
 *
 * Proves the whole loop runs from real observation-store data, through the
 * deterministic generation + unified store + apply pipeline, to a versioned,
 * git-committed guidance edit — under the pilot's elevated-stakes guarantees.
 *
 * AC mapping (AC of record, captured by astrid 2026-07-11T05:47:46Z):
 *
 *   - AC6.1 — at least one proposal generated FROM observation-store data (not a
 *     hand-built cluster), visible in the `/admin/api/proposals` console, applied
 *     to dev-impl guidance, version bumped, git-committed.
 *   - AC6.2 — baseline captured at apply with a DEFINED observation window
 *     (since ≤ until, both ISO); the row carries it for the before/after compare.
 *   - AC6.4 — apply/deploy to prod requires a HUMAN (Matt) sign-off; an AI
 *     self-sign-off (or none) is refused with NO write, NO commit, NO version
 *     bump.
 *   - AC6.3 — when the pilot is fed synthetic seed data, a real-data
 *     verification follow-up ticket MUST be supplied, or the run is refused; the
 *     synthetic rows remain flagged synthetic in the store.
 *
 * The harness under test (src/pilot/dev-impl-pilot.ts) does not exist yet, so
 * every case here is RED until it is implemented.
 */
import request from "supertest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp } from "../index.js";
import { reloadAgents } from "../agents.js";
import type { GenerationContext } from "../proposal/proposal-generator.js";
import {
  runDevImplPilot,
  seedSyntheticObservations,
  syntheticObservationIds,
  SignOffRequiredError,
  type PilotDeps,
} from "./dev-impl-pilot.js";

const ADMIN_SECRET = "ai2041-admin-secret";
const WORKFLOW = "dev-impl";
const STATE = "write-tests";
const REASON = "missing-tests" as const;
const guidanceRel = path.join("workflows", WORKFLOW, `${STATE}.md`);
const defRel = path.join("workflows", `${WORKFLOW}.yaml`);

// Clock pinned between the seeded baseline rows (July) and the post-apply rows
// (August) so the captured window and any comparison are deterministic.
const PILOT_NOW_MS = Date.parse("2026-07-15T00:00:00.000Z");

function defYaml(version: number): string {
  return `id: ${WORKFLOW}
version: ${version}
archetype: single-task
entry_state: ${STATE}
states:
  - id: ${STATE}
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: done
  - id: done
    kind: terminal
    native_state: done
`;
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root });
}

function headCount(root: string): number {
  return Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root }).toString().trim());
}

function defVersion(root: string): number {
  const yaml = fs.readFileSync(path.join(root, defRel), "utf8");
  const m = yaml.match(/^\s*version:\s*(\d+)/m);
  if (!m) throw new Error("def has no version line");
  return Number(m[1]);
}

describe("AI-2041 — dev-impl learning-loop pilot (end to end)", () => {
  let dir: string;
  let configRoot: string;
  let appState: ReturnType<typeof createApp>;
  let ctx: GenerationContext;

  /** Reads the ACTUAL on-disk guidance so oldContent.hash matches the TOCTOU re-hash. */
  function makeCtx(): GenerationContext {
    return {
      readSurfaces: (workflowId, stateId) => {
        if (workflowId !== WORKFLOW || stateId !== STATE) return [];
        return [
          {
            kind: "guidance",
            path: guidanceRel,
            content: fs.readFileSync(path.join(configRoot, guidanceRel), "utf8"),
          },
        ];
      },
    };
  }

  /** Seed N real reject observations of one crossing (workflow, state, reason). */
  function seedRealCrossingPattern(count: number): string[] {
    const tickets: string[] = [];
    for (let i = 0; i < count; i++) {
      const ticket = `AI-OBS-${i}`;
      tickets.push(ticket);
      appState.observationStore.append({
        ticket,
        workflow: WORKFLOW,
        step: STATE,
        fromBody: "tdd",
        reviewerBody: "cra",
        reasonCode: REASON,
        timestamp: `2026-07-0${(i % 9) + 1}T00:00:00.000Z`,
      });
    }
    return tickets;
  }

  /** The pilot deps common to the happy path; individual tests override fields. */
  function baseDeps(overrides: Partial<PilotDeps> = {}): PilotDeps {
    return {
      observationStore: appState.observationStore,
      proposalStore: appState.proposalStore,
      generationContext: ctx,
      configRoot,
      now: () => PILOT_NOW_MS,
      threshold: 3,
      signOff: { approver: "Matt", kind: "human" },
      ...overrides,
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2041-pilot-"));

    const webDist = path.join(dir, "web-dist");
    fs.mkdirSync(webDist, { recursive: true });
    fs.writeFileSync(path.join(webDist, "index.html"), '<!doctype html><div id="root"></div>', "utf8");
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [] }), "utf8");

    // A git-tracked instance-config dir the apply pipeline commits into.
    configRoot = path.join(dir, "config");
    fs.mkdirSync(path.join(configRoot, "workflows", WORKFLOW), { recursive: true });
    fs.writeFileSync(path.join(configRoot, defRel), defYaml(1), "utf8");
    fs.writeFileSync(
      path.join(configRoot, guidanceRel),
      "# write-tests\n\nWrite failing tests covering every in-scope AC before implementation.\n",
      "utf8",
    );
    git(configRoot, ["init", "-q"]);
    git(configRoot, ["config", "user.email", "igor@fancymatt.local"]);
    git(configRoot, ["config", "user.name", "igor"]);
    git(configRoot, ["add", "-A"]);
    git(configRoot, ["commit", "-q", "-m", "seed"]);

    process.env.AGENTS_FILE = agentsFile;
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.ADMIN_WEB_DIST = webDist;
    process.env.LINEAR_CONNECTOR_CONFIG_DIR = configRoot;
    reloadAgents();

    appState = createApp({
      proposalsDbPath: path.join(dir, "proposals.db"),
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "opevents.db"),
      observationsDbPath: path.join(dir, "obs.db"),
    });
    ctx = makeCtx();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.ADMIN_SECRET;
    delete process.env.ADMIN_WEB_DIST;
    delete process.env.LINEAR_CONNECTOR_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC6.1 — proposal generated from observation-store data → console → applied, versioned, committed", async () => {
    const tickets = seedRealCrossingPattern(5);
    const versionBefore = defVersion(configRoot);
    const commitsBefore = headCount(configRoot);

    const result = await runDevImplPilot(baseDeps());

    // Applied to dev-impl guidance, one version bump, one new git commit.
    expect(result.status).toBe("applied");
    expect(result.version).toBe(versionBefore + 1);
    expect(defVersion(configRoot)).toBe(versionBefore + 1);
    expect(headCount(configRoot)).toBe(commitsBefore + 1);
    expect(result.commit).toMatch(/^[0-9a-f]{7,40}$/);

    // The commit the pilot reports IS the config-root repo's new HEAD.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: configRoot }).toString().trim();
    expect(head).toBe(result.commit);

    // The proposal came FROM observation-store data — its evidence cites the
    // seeded tickets, and the console queue surfaces it for review.
    const row = appState.proposalStore.getById(result.proposalId);
    expect(row?.status).toBe("applied");
    const evidence = (row?.proposal as { evidenceCluster?: { ticketIds?: string[] } } | null)
      ?.evidenceCluster;
    expect(evidence?.ticketIds ?? []).toEqual(expect.arrayContaining([tickets[0]]));

    const listRes = await request(appState.app)
      .get("/admin/api/proposals")
      .set("x-admin-secret", ADMIN_SECRET);
    expect(listRes.status).toBe(200);
    const ids = (listRes.body.proposals as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(result.proposalId);

    // The guidance surface actually changed on disk.
    const guidance = fs.readFileSync(path.join(configRoot, guidanceRel), "utf8");
    expect(guidance).not.toBe(
      "# write-tests\n\nWrite failing tests covering every in-scope AC before implementation.\n",
    );
  });

  it("AC6.2 — apply captures a defined observation window on the applied record", async () => {
    seedRealCrossingPattern(5);

    const result = await runDevImplPilot(baseDeps());

    expect(result.baseline).toBeDefined();
    const { since, until } = result.baseline.window;
    expect(typeof since).toBe("string");
    expect(typeof until).toBe("string");
    expect(since.length).toBeGreaterThan(0);
    expect(until.length).toBeGreaterThan(0);
    // A window is only defined if it doesn't run backwards (ISO sorts lexically).
    expect(since <= until).toBe(true);

    // The window is durably attached to the applied proposal row for later
    // before/after comparison — not just returned in-memory.
    const row = appState.proposalStore.getById(result.proposalId);
    expect(row?.metricsBaseline?.window).toEqual(result.baseline.window);
  });

  it("AC6.4 — an AI self-sign-off is refused: no write, no commit, no version bump", async () => {
    seedRealCrossingPattern(5);
    const versionBefore = defVersion(configRoot);
    const commitsBefore = headCount(configRoot);

    await expect(
      runDevImplPilot(baseDeps({ signOff: { approver: "tdd", kind: "ai" } })),
    ).rejects.toBeInstanceOf(SignOffRequiredError);

    // Elevated stakes level 0: nothing was applied on an AI self-sign-off.
    expect(defVersion(configRoot)).toBe(versionBefore);
    expect(headCount(configRoot)).toBe(commitsBefore);
  });

  it("AC6.4 — a missing sign-off is refused: no commit", async () => {
    seedRealCrossingPattern(5);
    const commitsBefore = headCount(configRoot);

    await expect(runDevImplPilot(baseDeps({ signOff: null }))).rejects.toBeInstanceOf(
      SignOffRequiredError,
    );
    expect(headCount(configRoot)).toBe(commitsBefore);
  });

  it("AC6.3 — synthetic seed data without a real-data verification follow-up ticket is refused", async () => {
    seedSyntheticObservations(appState.observationStore, [
      {
        ticket: "AI-SYNTH-1",
        workflow: WORKFLOW,
        step: STATE,
        fromBody: "tdd",
        reviewerBody: "cra",
        reasonCode: REASON,
        timestamp: "2026-07-05T00:00:00.000Z",
      },
      {
        ticket: "AI-SYNTH-2",
        workflow: WORKFLOW,
        step: STATE,
        fromBody: "tdd",
        reviewerBody: "cra",
        reasonCode: REASON,
        timestamp: "2026-07-05T00:00:00.000Z",
      },
      {
        ticket: "AI-SYNTH-3",
        workflow: WORKFLOW,
        step: STATE,
        fromBody: "tdd",
        reviewerBody: "cra",
        reasonCode: REASON,
        timestamp: "2026-07-05T00:00:00.000Z",
      },
    ]);
    const commitsBefore = headCount(configRoot);

    // synthetic:true but no realDataFollowupTicket → the AC6.3 contingency is
    // violated; the pilot must refuse rather than call the AC met on synthetic
    // data with no follow-up on record.
    await expect(
      runDevImplPilot(baseDeps({ synthetic: true, realDataFollowupTicket: null })),
    ).rejects.toThrow(/follow-?up/i);
    expect(headCount(configRoot)).toBe(commitsBefore);
  });

  it("AC6.3 — synthetic run proceeds with a follow-up ticket, and the seeded rows stay flagged synthetic", async () => {
    const ids = seedSyntheticObservations(appState.observationStore, [
      {
        ticket: "AI-SYNTH-1",
        workflow: WORKFLOW,
        step: STATE,
        fromBody: "tdd",
        reviewerBody: "cra",
        reasonCode: REASON,
        timestamp: "2026-07-05T00:00:00.000Z",
      },
      {
        ticket: "AI-SYNTH-2",
        workflow: WORKFLOW,
        step: STATE,
        fromBody: "tdd",
        reviewerBody: "cra",
        reasonCode: REASON,
        timestamp: "2026-07-05T00:00:00.000Z",
      },
      {
        ticket: "AI-SYNTH-3",
        workflow: WORKFLOW,
        step: STATE,
        fromBody: "tdd",
        reviewerBody: "cra",
        reasonCode: REASON,
        timestamp: "2026-07-05T00:00:00.000Z",
      },
    ]);

    const result = await runDevImplPilot(
      baseDeps({ synthetic: true, realDataFollowupTicket: "AI-9999" }),
    );

    expect(result.status).toBe("applied");
    expect(result.synthetic).toBe(true);
    expect(result.realDataFollowupTicket).toBe("AI-9999");

    // The synthetic provenance is preserved in the store — the pilot did not
    // launder synthetic rows into looking real.
    const synthetic = syntheticObservationIds(appState.observationStore);
    for (const id of ids) {
      expect(synthetic.has(id)).toBe(true);
    }
  });
});
