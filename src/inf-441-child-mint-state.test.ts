import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeFanout } from "./fanout.js";

/**
 * REPRO: INF-441 - sprint-spawner: spawned children mint to Backlog (dispatch-skipped) 
 * instead of To Do → silently inert.
 */

describe("INF-441 Repro — child mint state", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ body: any }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("FIX: children mint to 'state:todo' by default (INF-441)", async () => {
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init?.body as string);
      fetchCalls.push({ body });

      if (body.query.includes("IssueTeamParent")) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: "p1",
              title: "Parent",
              description: "## findings\n- **F1**",
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
                  { id: "l-wf", name: "wf:dev-impl" },
                  { id: "l-intake", name: "state:intake" },
                  { id: "l-todo", name: "state:todo" }
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
              issue: { id: "c1", identifier: "AI-1" }
            }
          }
        }));
      }
      if (body.query.includes("commentCreate")) {
        return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }));
      }
      return new Response(JSON.stringify({ data: {} }));
    };

    const config = { spec_source: "findings", child_workflow: "wf:dev-impl" };
    await executeFanout("AI-P", "tok", config as any, { skipPreview: true });

    const createCall = fetchCalls.find(c => c.body.query.includes("issueCreate"));
    const labelIds = createCall.body.variables.input.labelIds;
    
    // After the fix, we expect it NOT to be intake, but todo.
    expect(labelIds).toContain("l-todo");
    expect(labelIds).not.toContain("l-intake");
  });
});
