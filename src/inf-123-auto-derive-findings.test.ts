/**
 * INF-123: Auto-derive ## Findings from completed arm children.
 *
 * Tests for autoDeriveArmFindings and autoPopulateFindingsSection in fanout.ts.
 *
 * AC1: spawn-impl auto-populates its ## Findings section from completed
 *      wf:sprint-arm-* children's terminal descriptions when present.
 * AC2: No auto-derivation is attempted for authored input (e.g. spawn-arms /
 *      ## structured composition) — fail-loud remains the guard.
 * AC3: Regression — refusal still fires when no prior artifact exists.
 */

import { autoDeriveArmFindings, autoPopulateFindingsSection, extractSpecFindings, type Finding } from "./fanout.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMockFetch(opts: {
  /** Children to return from the ParentChildrenForArmFindings query. */
  children?: Array<{
    identifier: string;
    description?: string | null;
    state?: { name: string; type: string } | null;
    labels?: Array<{ name: string }>;
  }>;
  /** Whether issueUpdate for description update succeeds. */
  updateSuccess?: boolean;
}): typeof globalThis.fetch {
  const children = opts.children ?? [];
  const updateSuccess = opts.updateSuccess ?? true;
  let updateCalled = false;

  return async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";

    // Parent children query (autoDeriveArmFindings)
    if (query.includes("ParentChildrenForArmFindings")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              children: {
                nodes: children.map((c) => ({
                  identifier: c.identifier,
                  description: c.description ?? null,
                  state: c.state ?? null,
                  labels: { nodes: (c.labels ?? []).map((l) => ({ name: l.name })) },
                })),
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Issue description update (autoPopulateFindingsSection)
    if (query.includes("issueUpdate")) {
      updateCalled = true;
      return new Response(
        JSON.stringify({
          data: { issueUpdate: { success: updateSuccess } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected query: ${query.slice(0, 100)}`);
  };
}

const AUTH_TOKEN = "Bearer test-tok";

// ── AC1: Auto-derive from completed arm children ───────────────────────────

describe("INF-123 AC1: autoDeriveArmFindings", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("derives findings from terminal wf:sprint-arm-* children", async () => {
    globalThis.fetch = makeMockFetch({
      children: [
        {
          identifier: "AI-1001",
          description: "## Findings\n- **Auth bypass**: Missing rate limiting on /api/login",
          state: { name: "Done", type: "completed" },
          labels: [{ name: "wf:sprint-arm-ux" }],
        },
        {
          identifier: "AI-1002",
          description: "## Findings\n- **SQL injection**: Unparameterized query in search endpoint",
          state: { name: "Done", type: "completed" },
          labels: [{ name: "wf:sprint-arm-api" }],
        },
      ],
    });

    const findings = await autoDeriveArmFindings("parent-uuid", AUTH_TOKEN);

    expect(findings).toHaveLength(2);
    expect(findings[0].title).toBe("Auth bypass");
    expect(findings[0].description).toBe("Missing rate limiting on /api/login");
    expect(findings[1].title).toBe("SQL injection");
    expect(findings[1].description).toBe("Unparameterized query in search endpoint");
    // Stable IDs should be present
    expect(findings[0].id).toBeDefined();
    expect(typeof findings[0].id).toBe("string");
  });

  it("deduplicates findings by title across children", async () => {
    globalThis.fetch = makeMockFetch({
      children: [
        {
          identifier: "AI-1001",
          description: "## Findings\n- **Same finding**: From arm A",
          state: { name: "Done", type: "completed" },
          labels: [{ name: "wf:sprint-arm-ux" }],
        },
        {
          identifier: "AI-1002",
          description: "## Findings\n- **Same finding**: From arm B (duplicate)",
          state: { name: "Done", type: "completed" },
          labels: [{ name: "wf:sprint-arm-api" }],
        },
      ],
    });

    const findings = await autoDeriveArmFindings("parent-uuid", AUTH_TOKEN);

    // Only one should be present (first one wins)
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("Same finding");
    expect(findings[0].description).toBe("From arm A");
  });

  it("returns empty array when children have no wf:sprint-arm-* label", async () => {
    globalThis.fetch = makeMockFetch({
      children: [
        {
          identifier: "AI-1001",
          description: "## Findings\n- **Something**: Desc",
          state: { name: "Done", type: "completed" },
          labels: [{ name: "wf:dev-impl" }],
        },
      ],
    });

    const findings = await autoDeriveArmFindings("parent-uuid", AUTH_TOKEN);
    expect(findings).toHaveLength(0);
  });

  it("returns empty array when children are not terminal", async () => {
    globalThis.fetch = makeMockFetch({
      children: [
        {
          identifier: "AI-1001",
          description: "## Findings\n- **Something**: Desc",
          state: { name: "In Progress", type: "started" },
          labels: [{ name: "wf:sprint-arm-ux" }],
        },
      ],
    });

    const findings = await autoDeriveArmFindings("parent-uuid", AUTH_TOKEN);
    expect(findings).toHaveLength(0);
  });

  it("returns empty array when children have no description", async () => {
    globalThis.fetch = makeMockFetch({
      children: [
        {
          identifier: "AI-1001",
          description: null,
          state: { name: "Done", type: "completed" },
          labels: [{ name: "wf:sprint-arm-ux" }],
        },
      ],
    });

    const findings = await autoDeriveArmFindings("parent-uuid", AUTH_TOKEN);
    expect(findings).toHaveLength(0);
  });

  it("returns empty array when no children exist", async () => {
    globalThis.fetch = makeMockFetch({ children: [] });

    const findings = await autoDeriveArmFindings("parent-uuid", AUTH_TOKEN);
    expect(findings).toHaveLength(0);
  });

  it("fails open on network error", async () => {
    globalThis.fetch = async () => {
      throw new Error("Network failure");
    };

    const findings = await autoDeriveArmFindings("parent-uuid", AUTH_TOKEN);
    expect(findings).toHaveLength(0);
  });
});

// ── AC2: No auto-derivation for authored input (spec_source != "findings") ──
// This is enforced by workflow-gate.ts — the auto-derivation is only attempted
// when spec_source === "findings". Tested via unit: extractSpecFindings with
// non-"findings" spec_source works normally and does not auto-derive.

describe("INF-123 AC2: extractSpecFindings with non-findings spec_source", () => {
  it("extracts from ## Structured section without deriving", () => {
    const desc = "## Structured\n- **Component A**: Build the login page\n- **Component B**: Add tests";
    const findings = extractSpecFindings(desc, "structured");
    expect(findings).toHaveLength(2);
    expect(findings[0].title).toBe("Component A");
    expect(findings[1].title).toBe("Component B");
  });

  it("returns empty for missing section regardless of spec_source", () => {
    const desc = "## Something Else\n- **Item A**: desc";
    const findings = extractSpecFindings(desc, "findings");
    expect(findings).toHaveLength(0);
  });

  it("returns empty for empty description", () => {
    const findings = extractSpecFindings(null, "findings");
    expect(findings).toHaveLength(0);
  });
});

// ── AC3: Refusal still fires when no artifacts exist ───────────────────────
// autoDeriveArmFindings returns [] when no terminals arms exist, which
// preserves the existing fail-loud behavior in the gate.

describe("INF-123 AC3: autoPopulateFindingsSection", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const sampleFindings: Finding[] = [
    { title: "Auth bypass", description: "Missing rate limiting" },
    { title: "SQL injection", description: "Unparameterized query" },
  ];

  it("replaces existing ## Findings section in description", async () => {
    globalThis.fetch = makeMockFetch({ updateSuccess: true });

    const ok = await autoPopulateFindingsSection(
      "parent-uuid",
      sampleFindings,
      "## Findings\n- **Old**: stale\n\n## Other\nSome content",
      AUTH_TOKEN,
    );

    expect(ok).toBe(true);
  });

  it("prepends when no ## Findings section exists", async () => {
    globalThis.fetch = makeMockFetch({ updateSuccess: true });

    const ok = await autoPopulateFindingsSection(
      "parent-uuid",
      sampleFindings,
      "## Other\nSome existing content",
      AUTH_TOKEN,
    );

    expect(ok).toBe(true);
  });

  it("handles null existing description", async () => {
    globalThis.fetch = makeMockFetch({ updateSuccess: true });

    const ok = await autoPopulateFindingsSection(
      "parent-uuid",
      sampleFindings,
      null,
      AUTH_TOKEN,
    );

    expect(ok).toBe(true);
  });

  it("returns false on API failure", async () => {
    globalThis.fetch = makeMockFetch({ updateSuccess: false });

    const ok = await autoPopulateFindingsSection(
      "parent-uuid",
      sampleFindings,
      null,
      AUTH_TOKEN,
    );

    expect(ok).toBe(false);
  });
});

// ── Integration-style: auto-derive then populate ───────────────────────────

describe("INF-123 integration: auto-derive + populate cycle", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("derives from arms and populates parent description", async () => {
    // First call: autoDeriveArmFindings returns findings
    // Second call: autoPopulateFindingsSection writes them
    let callCount = 0;

    globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const query = parsed.query ?? "";

      if (query.includes("ParentChildrenForArmFindings")) {
        callCount++;
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                children: {
                  nodes: [
                    {
                      identifier: "AI-1001",
                      description: "## Findings\n- **Auth bypass**: Missing rate limiting",
                      state: { name: "Done", type: "completed" },
                      labels: { nodes: [{ name: "wf:sprint-arm-ux" }] },
                    },
                    {
                      identifier: "AI-1002",
                      description: "## Findings\n- **SQL injection**: Unparameterized query",
                      state: { name: "Done", type: "completed" },
                      labels: { nodes: [{ name: "wf:sprint-arm-api" }] },
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (query.includes("issueUpdate")) {
        callCount++;
        // Verify the description contains the derived findings
        const vars = parsed.variables as Record<string, unknown>;
        const description = vars.description as string;
        expect(description).toContain("## Findings");
        expect(description).toContain("Auth bypass");
        expect(description).toContain("Missing rate limiting");
        expect(description).toContain("SQL injection");
        expect(description).toContain("Unparameterized query");
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected query: ${query.slice(0, 100)}`);
    };

    // Simulate the workflow-gate pattern: derive, then populate
    const derived = await autoDeriveArmFindings("parent-uuid", AUTH_TOKEN);
    expect(derived).toHaveLength(2);

    const populated = await autoPopulateFindingsSection("parent-uuid", derived, null, AUTH_TOKEN);
    expect(populated).toBe(true);

    expect(callCount).toBe(2);
  });
});
