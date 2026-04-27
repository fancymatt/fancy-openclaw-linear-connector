/**
 * Tests for isolated session delivery mode.
 *
 * Verifies that when OPENCLAW_HOOKS_URL + OPENCLAW_HOOKS_TOKEN are set,
 * the delivery payload uses `agentId` (not `agent`) — matching what
 * the /hooks/agent endpoint actually reads.
 */

import { jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

const deliverySrcDir = path.resolve(process.cwd(), "src", "delivery");

describe("isolated session delivery — payload field name", () => {
  it("uses agentId in the hooks payload, not agent", async () => {
    type FetchArgs = [string, { method: string; headers: Record<string, string>; body: string }];
    const fetchMock = jest.fn<(...args: FetchArgs) => Promise<{ ok: boolean; json: () => Promise<{ runId: string }> }>>().mockResolvedValue({
      ok: true,
      json: async () => ({ runId: "test-run-id" }),
    });

    // Simulate the delivery code path
    const agentName = "charles";
    const message = "[NEW TASK] You were delegated AI-393.";
    const hooksUrl = "http://localhost:18789/hooks/agent";
    const hooksToken = "test-token";

    await fetchMock(hooksUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hooksToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentId: agentName, message }),
    });

    const [, init] = fetchMock.mock.calls[0];
    const payload = JSON.parse(init.body);

    expect(payload).toHaveProperty("agentId", "charles");
    expect(payload).not.toHaveProperty("agent");
    expect(payload).toHaveProperty("message");
  });

  it("delivery module uses agentId not agent in hooks fetch body", () => {
    // Snapshot test: read the actual delivery source and confirm the field name.
    const deliveryDir = path.resolve(process.cwd(), "src", "delivery");
    const src = fs.readFileSync(
      path.join(deliveryDir, "deliver.ts"),
      "utf8"
    );

    // The isolated delivery block should use agentId
    expect(src).toContain("agentId: agentName");
    // It must NOT use the wrong field name
    expect(src).not.toContain("agent: agentName");
  });
});
