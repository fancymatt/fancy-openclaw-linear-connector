import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import request from "supertest";
import { createApp } from "../index.js";
import { resetWorkflowCache, resetNativeStateCache } from "../workflow-gate.js";
import { resetPolicyCache } from "../escalation-gate.js";
import { reloadAgents } from "../agents.js";

/**
 * INF-474/475: sprint-workflow end-to-end integration-test harness.
 * Drives a full spawner cycle and asserts canonical hierarchy.
 */

const MOCK_TEAM_ID = "team-fancymatt";
const MOCK_TOKEN = "mock-token";
const ASTRID_ID = "astrid-uuid";

describe("INF-474/475: sprint-workflow e2e integration-test harness", () => {
  let tmpDir: string;
  let defsDir: string;
  let dataDir: string;
  let app: any;
  let server: any;
  let mockFetch: jest.Mock<typeof fetch>;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-474-e2e-"));
    defsDir = path.join(tmpDir, "defs");
    dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(defsDir);
    fs.mkdirSync(dataDir);

    // Setup environment for the connector
    process.env.WORKFLOW_DEFS_DIR = defsDir;
    process.env.DATA_DIR = dataDir;
    process.env.LOG_LEVEL = "info";
    process.env.ADMIN_SECRET = "test-secret";
    process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "policy.yaml");
    process.env.LINEAR_OAUTH_TOKEN = MOCK_TOKEN;

    const agentsFile = path.join(tmpDir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        {
          name: "astrid",
          linearUserId: ASTRID_ID,
          accessToken: MOCK_TOKEN,
          refreshToken: "mock-refresh",
          status: "active"
        },
        {
          name: "ai",
          linearUserId: "ai-uuid",
          accessToken: MOCK_TOKEN,
          refreshToken: "mock-refresh",
          status: "active"
        }
      ]
    }), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
    
    // Minimal policy
    fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, `
capabilities:
  - id: linear:transition
  - id: sprint:signoff
containers:
  - id: workflow
    grants: [linear:transition, sprint:signoff]
bodies:
  - id: astrid
    container: workflow
    fills_roles: [steward]
`, "utf8");

    // Copy canonical defs to tmpDir
    const repoRoot = process.cwd();
    const defSourceDir = path.join(repoRoot, "src/registered-defs");
    const defFiles = [
      "sprint-spawner.yaml",
      "sprint-scoping.yaml",
      "dev-sprint.yaml",
      "task.yaml",
      "dev-impl.yaml",
      "sprint-arm-scope.yaml"
    ];

    for (const f of defFiles) {
      const content = fs.readFileSync(path.join(defSourceDir, f), "utf8");
      fs.writeFileSync(path.join(defsDir, f), content);
    }

    mockFetch = jest.fn() as jest.Mock<typeof fetch>;
    global.fetch = mockFetch;

    app = createApp({
      bagDbPath: path.join(dataDir, "bag.db"),
      agentQueueDbPath: path.join(dataDir, "queue.db"),
    });
  });

  afterAll(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetWorkflowCache();
    resetPolicyCache();
    resetNativeStateCache();
  });

  function mockLinear(responses: Record<string, any>) {
    mockFetch.mockImplementation(async (url: any, init?: any) => {
      const body = JSON.parse(init?.body || "{}");
      const query = body.query || "";
      const variables = body.variables || {};

      for (const [key, resp] of Object.entries(responses)) {
        if (query.includes(key)) {
          const data = typeof resp === "function" ? resp(variables) : resp;
          return {
            ok: true,
            status: 200,
            json: async () => ({ data }),
            text: async () => JSON.stringify({ data }),
          } as any;
        }
      }
      
      // Default empty success for mutations not explicitly mocked
      if (query.trim().startsWith("mutation")) {
         const data = { success: true, issueCreate: { success: true, issue: { id: "new-id", identifier: "NEW-1" } }, issueUpdate: { success: true }, commentCreate: { success: true } };
         return {
            ok: true,
            status: 200,
            json: async () => ({ data }),
            text: async () => JSON.stringify({ data }),
         } as any;
      }

      return { ok: true, status: 200, json: async () => ({ data: {} }), text: async () => JSON.stringify({ data: {} }) } as any;
    });
  }

  it("drives a full spawner-to-sprint-to-arms cycle and asserts canonical hierarchy", async () => {
    // 1. Mock Spawner creation (evaluating)
    const spawnerId = "INF-196";
    const sprintId = "sprint-uuid";
    const scopeSubparentId = "scope-uuid";
    const implSubparentId = "impl-uuid";

    mockLinear({
      "IssueContext": {
        issue: {
          identifier: spawnerId,
          labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:launching" }] },
          delegate: { id: ASTRID_ID }
        }
      },
      "IssueWithLabels": {
        issue: {
          id: "spawner-uuid",
          identifier: spawnerId,
          team: { id: MOCK_TEAM_ID },
          labels: { nodes: [{ id: "l1", name: "wf:sprint-spawner" }, { id: "l2", name: "state:launching" }] }
        }
      },
      "IssueTeamParent": {
        issue: {
          id: "spawner-uuid",
          title: "Spawner",
          description: "## sprint\n- **Cycle 7 Sprint**",
          team: { id: MOCK_TEAM_ID },
          labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:launching" }] }
        }
      },
      "TeamLabels": {
        team: {
          labels: {
            nodes: [
              { id: "wf-task", name: "wf:task" },
              { id: "wf-dev-sprint", name: "wf:dev-sprint" },
              { id: "state-intake", name: "state:intake" },
              { id: "state-todo", name: "state:todo" },
              { id: "state-launching", name: "state:launching" },
              { id: "state-managing", name: "state:managing" }
            ]
          }
        }
      },
      "TeamStates": {
        team: {
          states: {
            nodes: [
              { id: "s-intake", name: "Backlog", type: "backlog" },
              { id: "s-todo", name: "To Do", type: "todo" },
              { id: "s-doing", name: "Doing", type: "doing" },
              { id: "s-managing", name: "Managing", type: "managing" }
            ]
          }
        }
      }
    });

    // 2. Trigger transition to 'launching' (skipped intermediate for brevity in this test)
    // Actually let's just test the 'launching' fanout directly via proxy call
    const res = await request(app.app)
      .post("/proxy/graphql")
      .set("x-openclaw-agent-id", "astrid")
      .set("x-openclaw-agent", "astrid")
      .set("x-openclaw-linear-cli-version", "0.3.5")
      .set("x-openclaw-linear-intent", "spawn")
      .set("x-openclaw-command-id", "test-command-1")
      .set("authorization", `Bearer ${MOCK_TOKEN}`)
      .send({
        query: `mutation { issueUpdate(id: "${spawnerId}", input: { labelIds: ["state-launching"] }) { success } }`,
      });

    expect(res.status).toBe(200);

    // 3. Verify dev-sprint creation and skeleton creation
    // We expect 4 issueCreate calls: 1 for dev-sprint, 3 for skeleton (Scope, Implementation, Validation)
    const createCalls = mockFetch.mock.calls.filter(c => (JSON.parse(c[1]?.body as string).query || "").includes("issueCreate"));
    expect(createCalls.length).toBe(4);
    
    const titles = createCalls.map(c => JSON.parse(c[1]?.body as string).variables.input.title);
    expect(titles).toContain("Cycle 7 Sprint");
    expect(titles).toContain("Scope");
    expect(titles).toContain("Implementation");
    expect(titles).toContain("Validation");

    // 4. Test Arm Fan-out re-parenting
    mockFetch.mockClear();
    mockLinear({
      "IssueTeamParent": {
        issue: {
          id: sprintId,
          identifier: "SPRINT-1",
          title: "Cycle 7 Sprint",
          description: "## Structured\n- [wf:sprint-arm-scope] Research Task",
          team: { id: MOCK_TEAM_ID },
          labels: { nodes: [{ name: "wf:dev-sprint" }] }
        }
      },
      "IssueChildren": { // findIssueByTitle mock
        issue: {
          children: {
            nodes: [
              { id: scopeSubparentId, title: "Scope" },
              { id: implSubparentId, title: "Implementation" }
            ]
          }
        }
      },
      "TeamLabels": {
        team: {
          labels: {
            nodes: [
              { id: "wf-arm-scope", name: "wf:sprint-arm-scope" },
              { id: "state-todo", name: "state:todo" }
            ]
          }
        }
      }
    });

    // Manually trigger executeFanout (or via proxy)
    const { executeFanout } = await import("../fanout.js");
    await executeFanout(sprintId, MOCK_TOKEN, {
       spec_source: "structured",
       child_workflow: "wf:sprint-arm-scope"
    }, { skipPreview: true });

    // Verify the Research Task is parented to Scope subticket
    const armCreateCall = mockFetch.mock.calls.find(c => {
       const body = JSON.parse(c[1]?.body as string);
       return body.query?.includes("CreateChild") && body.variables.input.title === "Research Task";
    });
    expect(armCreateCall).toBeDefined();
    expect(JSON.parse(armCreateCall![1]?.body as string).variables.input.parentId).toBe(scopeSubparentId);
  });

  it("handles Backlog pull-in re-parenting", async () => {
    const taskIdentifier = "TASK-1";
    const sprintInternalId = "sprint-uuid";
    const implSubparentId = "impl-uuid";

    mockLinear({
      "IssueLabels": (vars: any) => {
        if (vars.id === taskIdentifier || vars.id === "task-uuid") {
           return {
             issue: {
               id: "task-uuid",
               team: { id: MOCK_TEAM_ID },
               labels: { nodes: [{ id: "l-task", name: "wf:task" }] }
             }
           };
        }
        if (vars.id === sprintInternalId) {
           return {
             issue: {
               id: sprintInternalId,
               team: { id: MOCK_TEAM_ID },
               labels: { nodes: [{ id: "l-sprint", name: "wf:dev-sprint" }] }
             }
           };
        }
        return {};
      },
      "IssueChildren": {
        issue: {
          children: {
            nodes: [{ id: implSubparentId, title: "Implementation" }]
          }
        }
      }
    });

    // Simulate webhook: Task parented to Sprint
    const webhookPayload = {
      type: "Issue",
      action: "update",
      data: {
        id: "task-uuid",
        identifier: taskIdentifier,
        parentId: sprintInternalId,
        teamKey: "AI"
      },
      updatedFrom: {
        parentId: null
      }
    };

    await request(app.app)
      .post("/")
      .set("linear-event", "Issue")
      .send(webhookPayload);

    // Give background processing time
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify issueUpdate call for re-parenting
    const updateParentCall = mockFetch.mock.calls.find(c => {
       const body = JSON.parse(c[1]?.body as string);
       return body.query?.includes("UpdateParent") && body.variables.issueId === "task-uuid";
    });
    expect(updateParentCall).toBeDefined();
    expect(JSON.parse(updateParentCall![1]?.body as string).variables.parentId).toBe(implSubparentId);
  });
});
