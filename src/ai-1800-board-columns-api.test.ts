/**
 * AI-1800 AC1 — Board renders columns from workflow YAML order.
 *
 * Tests that the board API serves workflow definitions with their state
 * ordering so the frontend can render columns without hardcoding state lists.
 * Adding a new YAML def must produce zero-code-change columns (verified by
 * testing with a synthetic workflow def).
 *
 * AC1 contract:
 *   GET /api/board must return a `workflows` field alongside `tickets`,
 *   where each workflow entry contains `id` and an ordered `states` array
 *   (string[]). The frontend renders one column per state in list order.
 *   A synthetic workflow def enrolled with tickets must appear automatically.
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import yaml from "js-yaml";
import { createApp } from "./index.js";
import type { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";
import { resetWorkflowCache } from "./workflow-gate.js";

function tmpDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai1800-board-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

function getMirror(app: ReturnType<typeof createApp>): EnrolledTicketsStore {
  const mirror = (app as unknown as { enrolledTicketsStore?: EnrolledTicketsStore }).enrolledTicketsStore;
  if (!mirror) throw new Error("enrolledTicketsStore not exposed on createApp return");
  return mirror;
}

/** Write a synthetic workflow YAML file and return its directory path. */
function writeSyntheticWorkflowDef(
  workflowId: string,
  states: Array<{ id: string; kind?: string }>,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1800-wf-defs-"));
  const def = { id: workflowId, version: 1, entry_state: states[0].id, states };
  fs.writeFileSync(path.join(dir, `${workflowId}.yaml`), yaml.dump(def));
  return dir;
}

const ADMIN_SECRET = "ai1800-board-test";

describe("AI-1800 AC1: GET /api/board — workflow column ordering", () => {
  let app: ReturnType<typeof createApp>;
  let mirrorDbPath: string;
  let eventsDbPath: string;
  let mirror: EnrolledTicketsStore;
  let wfDefsDir: string;

  beforeEach(() => {
    resetWorkflowCache();
    mirrorDbPath = tmpDbPath("mirror");
    eventsDbPath = tmpDbPath("events");
    process.env.ADMIN_SECRET = ADMIN_SECRET;
  });

  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    resetWorkflowCache();
    fs.rmSync(path.dirname(mirrorDbPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(eventsDbPath), { recursive: true, force: true });
    // Only clean up temp dirs created by this test (mkdtemp prefix: ai1800-wf-defs-).
    // Never delete the canonical __fixtures__ directory — using startsWith(os.tmpdir())
    // alone is unsafe when the repo itself is cloned under /tmp.
    if (wfDefsDir && path.basename(wfDefsDir).startsWith('ai1800-wf-defs-')) {
      fs.rmSync(wfDefsDir, { recursive: true, force: true });
    }
  });

  it("board response includes a workflows array with state ordering", async () => {
    // Use the canonical dev-impl fixture
    wfDefsDir = path.resolve(__dirname, "__fixtures__");
    process.env.WORKFLOW_DEFS_DIR = wfDefsDir;

    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);

    const res = await request(app.app)
      .get("/admin/api/board")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toBeDefined();
    expect(Array.isArray(res.body.workflows)).toBe(true);
    // At least one workflow (dev-impl from fixtures)
    expect(res.body.workflows.length).toBeGreaterThanOrEqual(1);

    const devImpl = res.body.workflows.find((w: { id: string }) => w.id === "dev-impl");
    expect(devImpl).toBeDefined();
    expect(Array.isArray(devImpl.states)).toBe(true);
    // States should be strings, ordered as per the YAML
    expect(devImpl.states.length).toBeGreaterThan(0);
    // dev-impl v9 states in order: intake, write-tests, implementation,
    // code-review, deployment, host-deploy, ac-validate, done
    expect(devImpl.states[0]).toBe("intake");
    expect(devImpl.states[devImpl.states.length - 1]).toBe("done");
  });

  it("synthetic workflow def appears as columns with zero UI code changes", async () => {
    // Create a synthetic workflow not in the fixture directory
    const syntheticStates = [
      { id: "draft" },
      { id: "in-progress" },
      { id: "review" },
      { id: "complete", kind: "terminal" },
    ];
    wfDefsDir = writeSyntheticWorkflowDef("synthetic-review", syntheticStates);
    process.env.WORKFLOW_DEFS_DIR = wfDefsDir;

    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);

    // Enroll a ticket in the synthetic workflow
    mirror.enroll({
      ticketId: "AI-6001",
      workflow: "synthetic-review",
      state: "in-progress",
      delegate: "reviewer",
    });

    const res = await request(app.app)
      .get("/admin/api/board")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);

    // The synthetic workflow must appear in the workflows list
    const synth = res.body.workflows.find((w: { id: string }) => w.id === "synthetic-review");
    expect(synth).toBeDefined();
    expect(synth.states).toEqual(["draft", "in-progress", "review", "complete"]);

    // The enrolled ticket must also appear in tickets
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-6001");
    expect(ticket).toBeDefined();
    expect(ticket.workflow).toBe("synthetic-review");
    expect(ticket.state).toBe("in-progress");
  });

  it("workflows array only includes workflows that have enrolled tickets", async () => {
    // Use fixture dir with dev-impl, but only enroll in dev-impl
    wfDefsDir = path.resolve(__dirname, "__fixtures__");
    process.env.WORKFLOW_DEFS_DIR = wfDefsDir;

    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);

    mirror.enroll({ ticketId: "AI-6002", workflow: "dev-impl", state: "write-tests", delegate: "tdd" });

    const res = await request(app.app)
      .get("/admin/api/board")
      .set("x-admin-secret", ADMIN_SECRET);

    // The workflows list should include dev-impl (has enrolled tickets)
    const hasDevImpl = res.body.workflows.some((w: { id: string }) => w.id === "dev-impl");
    expect(hasDevImpl).toBe(true);

    // ux-audit fixture is also in __fixtures__/ but has no enrolled tickets
    // — it should NOT appear (only workflows with live enrolled tickets)
    const hasUxAudit = res.body.workflows.some((w: { id: string }) => w.id === "ux-audit");
    expect(hasUxAudit).toBe(false);
  });

  it("state order from YAML matches the column order in the response", async () => {
    // Verify order preservation: dev-impl states in YAML order
    wfDefsDir = path.resolve(__dirname, "__fixtures__");
    process.env.WORKFLOW_DEFS_DIR = wfDefsDir;

    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);

    const res = await request(app.app)
      .get("/admin/api/board")
      .set("x-admin-secret", ADMIN_SECRET);

    const devImpl = res.body.workflows.find((w: { id: string }) => w.id === "dev-impl");
    const expectedOrder = [
      "intake",
      "write-tests",
      "implementation",
      "code-review",
      "deployment",
      "host-deploy",
      "ac-validate",
      "done",
    ];
    expect(devImpl.states).toEqual(expectedOrder);
  });
});
