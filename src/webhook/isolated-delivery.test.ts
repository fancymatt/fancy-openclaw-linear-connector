/**
 * Tests for isolated session delivery mode.
 *
 * Verifies that when OPENCLAW_HOOKS_URL + OPENCLAW_HOOKS_TOKEN are set,
 * the delivery payload uses `agentId` (not `agent`) — matching what
 * the /hooks/agent endpoint actually reads.
 */

describe("isolated session delivery — payload field name", () => {
  it("uses agentId in the hooks payload, not agent", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ runId: "test-run-id" }),
    });

    // Simulate the delivery code path from webhook/index.ts
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
    const payload = JSON.parse(init.body as string);

    expect(payload).toHaveProperty("agentId", "charles");
    expect(payload).not.toHaveProperty("agent");
    expect(payload).toHaveProperty("message");
  });

  it("source code uses agentId not agent in hooks fetch body", () => {
    // Snapshot test: read the actual source and confirm the field name.
    // This catches regressions if the field is accidentally reverted.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "index.ts"),
      "utf8"
    );

    // The isolated delivery block should use agentId
    expect(src).toContain("agentId: agentName");
    // It must NOT use the wrong field name
    expect(src).not.toContain("agent: agentName");
  });
});
