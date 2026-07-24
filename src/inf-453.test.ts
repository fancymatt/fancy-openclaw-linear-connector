import { jest } from "@jest/globals";
/**
 * Regression test for INF-453: dev-sprint loops/stalls at spawn-arms with no
 * terminal path when arms delivered out-of-band.
 */

import { executeFanout } from "./fanout.js";
import { FanoutConfig } from "./workflow-gate.js";

describe("INF-453 regression: empty spawn loop", () => {
  const AUTH_TOKEN = "lin_api_test_token";
  const PARENT_ID = "parent-id";
  const CONFIG: FanoutConfig = {
    spec_source: "findings",
    child_workflow: "wf:task",
  };

  // Mock global fetch
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("executeFanout returns refused: true when no findings are found (INF-453 AC2)", async () => {
    global.fetch = jest.fn().mockImplementation((url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes("query IssueTeamParent")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: {
              issue: {
                id: PARENT_ID,
                title: "Parent Sprint",
                description: "Empty description with no findings section",
                team: { id: "team-id" },
                parent: null
              }
            }
          })
        });
      }
      return Promise.reject(new Error(`Unexpected query: ${body.query}`));
    }) as jest.Mock;

    const result = await executeFanout(PARENT_ID, AUTH_TOKEN, CONFIG);

    expect(result.refused).toBe(true);
    expect(result.created).toBe(0);
    expect(result.errors[0].message).toContain("No 'findings' entries found");
  });
});
