import { executeFanout } from "./fanout.js";

/**
 * REPRO: INF-478 - Sprint-scoping children mint at state:intake resolve to native Backlog 
 * (dispatch-skipped) — INF-441 only fixed state:todo path.
 */

describe("INF-478 Repro — sprint-scoping mint state", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ body: any }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("REPRO: sprint-scoping children mint to 'state:intake' if lookupEntryState returns it (INF-478)", async () => {
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init?.body as string);
      fetchCalls.push({ body });

      if (body.query.includes("IssueTeamParent")) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: "p1",
              title: "Cycle-7 Scoping",
              description: "## scoping\n- **Child 1**",
              team: { id: "t1" },
              parent: null
            }
          }
        }));
      }
      if (body.query.includes("TeamLabels")) {
        return new Response(JSON.stringify({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "l-wf", name: "wf:sprint-scoping" },
                  { id: "l-intake", name: "state:intake" },
                  { id: "l-todo", name: "state:todo" },
                  { id: "l-thinking", name: "state:thinking" }
                ]
              }
            }
          }
        }));
      }
      if (body.query.includes("IssueParent")) {
        return new Response(JSON.stringify({ data: { issue: { parent: null } } }));
      }
      if (body.query.includes("issueCreate")) {
        return new Response(JSON.stringify({
          data: {
            issueCreate: {
              success: true,
              issue: { id: "c1", identifier: "INF-471" }
            }
          }
        }));
      }
      if (body.query.includes("commentCreate")) {
        return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }));
      }
      return new Response(JSON.stringify({ data: {} }));
    };

    const config = { spec_source: "scoping", child_workflow: "wf:sprint-scoping" };
    // Simulate lookupEntryState returning state:intake as defined in the workflow def
    const lookupEntryState = async (wf: string) => "state:intake";
    
    await executeFanout("INF-471-P", "tok", config as any, { 
      skipPreview: true,
      lookupEntryState
    });

    const createCall = fetchCalls.find(c => c.body.query.includes("issueCreate"));
    const labelIds = createCall.body.variables.input.labelIds;
    
    // After the fix, we expect it NOT to be intake, but todo.
    expect(labelIds).not.toContain("l-intake");
    expect(labelIds).toContain("l-todo");
  });
});
