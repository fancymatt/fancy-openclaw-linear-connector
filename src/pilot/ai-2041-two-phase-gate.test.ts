/**
 * AI-2041 (P4-C6) — Two-phase gate: stage + apply seam.
 *
 * Validates that the pilot harness can be split into:
 *   Phase 1 (stage): distill → generate → persist, NO apply. No sign-off needed.
 *   Phase 2 (apply): load staged proposal → human sign-off gate → apply.
 *
 * This is the seam Grover needs to run the live pilot: stage surfaces the
 * proposal in the console for Matt's review, then apply runs only after his
 * explicit AC6.4 sign-off. The monolithic `runDevImplPilot` composes both phases;
 * these tests exercise them independently.
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
  stageDevImplPilot,
  applyStagedProposal,
  seedSyntheticObservations,
  SignOffRequiredError,
  type StagedPilotDeps,
  type ApplyStagedDeps,
} from "./dev-impl-pilot.js";

const ADMIN_SECRET = "ai2041secret";
const WORKFLOW = "dev-impl";
const STATE = "write-tests";
const REASON = "missing-tests" as const;
const guidanceRel = path.join("workflows", WORKFLOW, `${STATE}.md`);
const defRel = path.join("workflows", `${WORKFLOW}.yaml`);

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

describe("AI-2041 two-phase gate — stage then apply", () => {
  let dir: string;
  let configRoot: string;
  let appState: ReturnType<typeof createApp>;
  let ctx: GenerationContext;

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

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2041-2phase-"));

    const webDist = path.join(dir, "web-dist");
    fs.mkdirSync(webDist, { recursive: true });
    fs.writeFileSync(path.join(webDist, "index.html"), '<!doctype html><div id="root"></div>', "utf8");
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [] }), "utf8");

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

  it("stage phase persists proposal to console with NO version bump, NO commit, NO sign-off needed", async () => {
    seedRealCrossingPattern(5);
    const versionBefore = defVersion(configRoot);
    const commitsBefore = headCount(configRoot);

    // Stage — no sign-off, no configRoot needed.
    const staged = await stageDevImplPilot({
      observationStore: appState.observationStore,
      proposalStore: appState.proposalStore,
      generationContext: ctx,
      now: () => PILOT_NOW_MS,
      threshold: 3,
    });

    expect(staged.status).toBe("staged");
    expect(staged.proposalId).toBeTruthy();

    // No version bump, no commit.
    expect(defVersion(configRoot)).toBe(versionBefore);
    expect(headCount(configRoot)).toBe(commitsBefore);

    // The proposal IS in the store and surfaced via the console API.
    const row = appState.proposalStore.getById(staged.proposalId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
    expect(row!.proposal).not.toBeNull();

    const listRes = await request(appState.app)
      .get("/admin/api/proposals")
      .set("x-admin-secret", ADMIN_SECRET);
    expect(listRes.status).toBe(200);
    const ids = (listRes.body.proposals as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(staged.proposalId);

    // Guidance NOT changed on disk — stage doesn't write to config.
    const guidance = fs.readFileSync(path.join(configRoot, guidanceRel), "utf8");
    expect(guidance).toBe(
      "# write-tests\n\nWrite failing tests covering every in-scope AC before implementation.\n",
    );
  });

  it("apply phase requires human sign-off — AI self-sign-off refused with no write", async () => {
    seedRealCrossingPattern(5);
    const commitsBefore = headCount(configRoot);

    const staged = await stageDevImplPilot({
      observationStore: appState.observationStore,
      proposalStore: appState.proposalStore,
      generationContext: ctx,
      now: () => PILOT_NOW_MS,
      threshold: 3,
    });

    // AI sign-off on apply → refused.
    await expect(
      applyStagedProposal({
        proposalId: staged.proposalId,
        proposalStore: appState.proposalStore,
        observationStore: appState.observationStore,
        configRoot,
        now: () => PILOT_NOW_MS,
        signOff: { approver: "tdd", kind: "ai" },
      }),
    ).rejects.toBeInstanceOf(SignOffRequiredError);

    expect(headCount(configRoot)).toBe(commitsBefore);
  });

  it("apply phase requires human sign-off — null sign-off refused with no write", async () => {
    seedRealCrossingPattern(5);
    const commitsBefore = headCount(configRoot);

    const staged = await stageDevImplPilot({
      observationStore: appState.observationStore,
      proposalStore: appState.proposalStore,
      generationContext: ctx,
      now: () => PILOT_NOW_MS,
      threshold: 3,
    });

    await expect(
      applyStagedProposal({
        proposalId: staged.proposalId,
        proposalStore: appState.proposalStore,
        observationStore: appState.observationStore,
        configRoot,
        now: () => PILOT_NOW_MS,
        signOff: null,
      }),
    ).rejects.toBeInstanceOf(SignOffRequiredError);

    expect(headCount(configRoot)).toBe(commitsBefore);
  });

  it("two-phase flow: stage → review → apply with human sign-off produces version bump + commit", async () => {
    const tickets = seedRealCrossingPattern(5);
    const versionBefore = defVersion(configRoot);
    const commitsBefore = headCount(configRoot);

    // Phase 1: stage (no sign-off needed).
    const staged = await stageDevImplPilot({
      observationStore: appState.observationStore,
      proposalStore: appState.proposalStore,
      generationContext: ctx,
      now: () => PILOT_NOW_MS,
      threshold: 3,
    });

    // Phase 2: apply with human sign-off (Matt's AC6.4 gate).
    const result = await applyStagedProposal({
      proposalId: staged.proposalId,
      proposalStore: appState.proposalStore,
      observationStore: appState.observationStore,
      configRoot,
      now: () => PILOT_NOW_MS,
      signOff: { approver: "Matt", kind: "human" },
    });

    // Applied: one version bump, one new commit.
    expect(result.status).toBe("applied");
    expect(result.version).toBe(versionBefore + 1);
    expect(defVersion(configRoot)).toBe(versionBefore + 1);
    expect(headCount(configRoot)).toBe(commitsBefore + 1);
    expect(result.commit).toMatch(/^[0-9a-f]{7,40}$/);

    // The proposal is applied in the store.
    const row = appState.proposalStore.getById(staged.proposalId);
    expect(row?.status).toBe("applied");
    expect(row?.version).toBe(versionBefore + 1);
    expect(row?.commit).toBe(result.commit);

    // Evidence cites the seeded tickets.
    const evidence = (row?.proposal as { evidenceCluster?: { ticketIds?: string[] } } | null)
      ?.evidenceCluster;
    expect(evidence?.ticketIds ?? []).toEqual(expect.arrayContaining([tickets[0]]));

    // Baseline captured at apply (AC6.2).
    expect(result.baseline).toBeDefined();
    expect(result.baseline.window.since <= result.baseline.window.until).toBe(true);

    // Guidance changed on disk.
    const guidance = fs.readFileSync(path.join(configRoot, guidanceRel), "utf8");
    expect(guidance).not.toBe(
      "# write-tests\n\nWrite failing tests covering every in-scope AC before implementation.\n",
    );
  });

  it("stage phase with synthetic data requires follow-up ticket (AC6.3)", async () => {
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

    // synthetic:true but no follow-up ticket → refused.
    await expect(
      stageDevImplPilot({
        observationStore: appState.observationStore,
        proposalStore: appState.proposalStore,
        generationContext: ctx,
        now: () => PILOT_NOW_MS,
        threshold: 3,
        synthetic: true,
        realDataFollowupTicket: null,
      }),
    ).rejects.toThrow(/follow-?up/i);
  });

  it("stage phase with synthetic data and follow-up ticket succeeds", async () => {
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

    const staged = await stageDevImplPilot({
      observationStore: appState.observationStore,
      proposalStore: appState.proposalStore,
      generationContext: ctx,
      now: () => PILOT_NOW_MS,
      threshold: 3,
      synthetic: true,
      realDataFollowupTicket: "AI-2117",
    });

    expect(staged.status).toBe("staged");
    expect(staged.synthetic).toBe(true);
    expect(staged.realDataFollowupTicket).toBe("AI-2117");

    // Proposal persisted, visible in console.
    const row = appState.proposalStore.getById(staged.proposalId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
  });

  it("apply phase refuses for a non-existent proposal id", async () => {
    await expect(
      applyStagedProposal({
        proposalId: "does-not-exist",
        proposalStore: appState.proposalStore,
        observationStore: appState.observationStore,
        configRoot,
        now: () => PILOT_NOW_MS,
        signOff: { approver: "Matt", kind: "human" },
      }),
    ).rejects.toThrow(/not found in store/);
  });
});
