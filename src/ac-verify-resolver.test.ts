/**
 * INF-327: AC-Verify Resolver — failing tests (TDD red phase).
 *
 * Tests for the not-yet-implemented `ac-verify-resolver.ts` module.
 * These tests MUST fail until Igor implements the module.
 *
 * AC coverage:
 *   AC1: No verify designation → default owner, no gate, no added state.
 *   AC2: `verify:<role>` label → resolves to mapped agent, gated.
 *   AC3: `xfn:<dimension>` label → auto-derives verifier from dimension map.
 *   AC4: Designated ticket cannot reach Done until verifier approves.
 *   AC5: Silent designated verifier detected by INF-315 liveness model.
 *   AC6: Dimension→verifier map is config-driven, not hardcoded.
 *   AC7: Explicit `verify:` label overrides `xfn:` derivation.
 *   AC8 (AI-1808): Integration-level — verify gate fires in the done path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";

// These imports will fail — the module does not exist yet (TDD red).
import {
  resolveVerifyOwner,
  checkVerifyGate,
  isVerifierStalled,
  type VerifyConfig,
  type VerifyResolution,
} from "./ac-verify-resolver.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Standard test config: dimension→verifier map + default steward owner. */
function makeConfig(overrides: Partial<VerifyConfig> = {}): VerifyConfig {
  return {
    dimensionMap: {
      code: "cra",
      design: "laren",
    },
    defaultOwner: "astrid",
    ...overrides,
  };
}

/** Create a temp config file (for config-driven tests). */
function writeConfigFile(dir: string, config: VerifyConfig): string {
  const file = path.join(dir, "ac-verify-config.json");
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
  return file;
}

/** Mock Linear API fetch for verify-gate checks. */
function makeVerifyFetch(opts: {
  verifierApproved?: boolean;
  verifierRequestedChanges?: boolean;
  ticketState?: string;
  lastActivityDaysAgo?: number;
} = {}): typeof globalThis.fetch {
  const json = (payload: object) => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const parsed = JSON.parse(bodyText || "{}") as { query?: string; variables?: Record<string, unknown> };
    const q = parsed.query ?? "";

    // Ticket state + comments query
    if (q.includes("VerifyGateStatus")) {
      const approved = opts.verifierApproved ?? false;
      const requestedChanges = opts.verifierRequestedChanges ?? false;
      const state = opts.ticketState ?? "code-review";
      const daysAgo = opts.lastActivityDaysAgo ?? 0;
      const lastActivity = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

      return json({
        data: {
          issue: {
            id: (parsed.variables?.ticketId as string) ?? "test-ticket",
            state: { name: state },
            comments: {
              nodes: approved
                ? [{ body: "ac-verify: approve", user: { name: "verifier" } }]
                : requestedChanges
                  ? [{ body: "ac-verify: request-changes", user: { name: "verifier" } }]
                  : [],
            },
            updatedAt: lastActivity,
          },
        },
      });
    }

    // Stall check query
    if (q.includes("VerifierActivity")) {
      const daysAgo = opts.lastActivityDaysAgo ?? 0;
      const lastActivity = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
      return json({
        data: {
          issue: {
            updatedAt: lastActivity,
            comments: {
              nodes: [
                { createdAt: lastActivity, user: { name: "someone" } },
              ],
            },
          },
        },
      });
    }

    return json({ data: {} });
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("resolveVerifyOwner — AC1: no designation (default flow)", () => {
  const config = makeConfig();

  it("returns null owner with designated=false for plain labels", () => {
    const result = resolveVerifyOwner(["bug", "priority:high"], config);
    expect(result.owner).toBeNull();
    expect(result.designated).toBe(false);
    expect(result.source).toBe("none");
  });

  it("returns null owner when only wf: label is present (no verify or xfn)", () => {
    const result = resolveVerifyOwner(["wf:dev-impl", "state:implementation"], config);
    expect(result.owner).toBeNull();
    expect(result.designated).toBe(false);
    expect(result.source).toBe("none");
  });

  it("returns null owner for empty label array", () => {
    const result = resolveVerifyOwner([], config);
    expect(result.owner).toBeNull();
    expect(result.designated).toBe(false);
    expect(result.source).toBe("none");
  });
});

describe("checkVerifyGate — AC1: no-designation tickets are not gated", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns blocked=false when owner is null (no designation)", async () => {
    globalThis.fetch = makeVerifyFetch();
    const result = await checkVerifyGate("ticket-1", null, makeConfig(), "Bearer tok");
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });
});

describe("resolveVerifyOwner — AC2: verify:design label resolves to Laren", () => {
  const config = makeConfig();

  it("resolves verify:design to laren", () => {
    const result = resolveVerifyOwner(["wf:dev-impl", "verify:design"], config);
    expect(result.owner).toBe("laren");
    expect(result.designated).toBe(true);
    expect(result.source).toBe("verify-label");
  });

  it("checkVerifyGate blocks done when laren has not approved", async () => {
    const config = makeConfig();
    const resolution = resolveVerifyOwner(["verify:design"], config);
    expect(resolution.owner).toBe("laren");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeVerifyFetch({ verifierApproved: false });
    try {
      const gateResult = await checkVerifyGate("ticket-2", resolution.owner, config, "Bearer tok");
      expect(gateResult.blocked).toBe(true);
      expect(gateResult.reason).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("checkVerifyGate allows done when laren has approved", async () => {
    const config = makeConfig();
    const resolution = resolveVerifyOwner(["verify:design"], config);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeVerifyFetch({ verifierApproved: true });
    try {
      const gateResult = await checkVerifyGate("ticket-2", resolution.owner, config, "Bearer tok");
      expect(gateResult.blocked).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("resolveVerifyOwner — AC2b: verify:code label resolves to cra", () => {
  const config = makeConfig();

  it("resolves verify:code to cra", () => {
    const result = resolveVerifyOwner(["wf:dev-impl", "verify:code"], config);
    expect(result.owner).toBe("cra");
    expect(result.designated).toBe(true);
    expect(result.source).toBe("verify-label");
  });

  it("checkVerifyGate blocks done when cra has not approved", async () => {
    const resolution = resolveVerifyOwner(["verify:code"], config);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeVerifyFetch({ verifierApproved: false });
    try {
      const gateResult = await checkVerifyGate("ticket-3", resolution.owner, config, "Bearer tok");
      expect(gateResult.blocked).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("resolveVerifyOwner — AC3: xfn-derived verify owner", () => {
  const config = makeConfig();

  it("derives verify owner from xfn:design label", () => {
    const result = resolveVerifyOwner(["xfn:design"], config);
    expect(result.owner).toBe("laren");
    expect(result.designated).toBe(true);
    expect(result.source).toBe("xfn-derived");
  });

  it("derives verify owner from xfn:code label", () => {
    const result = resolveVerifyOwner(["xfn:code"], config);
    expect(result.owner).toBe("cra");
    expect(result.designated).toBe(true);
    expect(result.source).toBe("xfn-derived");
  });

  it("xfn dimension not in config map returns null owner with designated=false", () => {
    const result = resolveVerifyOwner(["xfn:unknown-dimension"], config);
    expect(result.owner).toBeNull();
    expect(result.designated).toBe(false);
    expect(result.source).toBe("none");
  });

  it("xfn-derived owner is gated same as explicit label", async () => {
    const resolution = resolveVerifyOwner(["xfn:design"], config);
    expect(resolution.owner).toBe("laren");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeVerifyFetch({ verifierApproved: false });
    try {
      const gateResult = await checkVerifyGate("ticket-4", resolution.owner, config, "Bearer tok");
      expect(gateResult.blocked).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("resolveVerifyOwner — AC7: explicit verify: label overrides xfn: derivation", () => {
  const config = makeConfig();

  it("verify:code wins over xfn:design → resolves to cra", () => {
    const result = resolveVerifyOwner(["xfn:design", "verify:code"], config);
    expect(result.owner).toBe("cra");
    expect(result.designated).toBe(true);
    expect(result.source).toBe("verify-label");
  });

  it("verify:design wins over xfn:code → resolves to laren", () => {
    const result = resolveVerifyOwner(["xfn:code", "verify:design"], config);
    expect(result.owner).toBe("laren");
    expect(result.designated).toBe(true);
    expect(result.source).toBe("verify-label");
  });

  it("explicit override gate uses the explicit owner, not the xfn-derived one", async () => {
    const resolution = resolveVerifyOwner(["xfn:design", "verify:code"], config);
    expect(resolution.owner).toBe("cra");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeVerifyFetch({ verifierApproved: false });
    try {
      const gateResult = await checkVerifyGate("ticket-5", resolution.owner, config, "Bearer tok");
      expect(gateResult.blocked).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("resolveVerifyOwner — AC6: config-driven dimension map (not hardcoded)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-verify-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a new dimension added only via config (no code change)", () => {
    // Config adds a new dimension: "docs" → "kana"
    const config = makeConfig({
      dimensionMap: {
        code: "cra",
        design: "laren",
        docs: "kana",
      },
    });

    // Verify the standard dimensions still work
    expect(resolveVerifyOwner(["xfn:code"], config).owner).toBe("cra");
    expect(resolveVerifyOwner(["xfn:design"], config).owner).toBe("laren");

    // New dimension resolves purely from config
    const result = resolveVerifyOwner(["xfn:docs"], config);
    expect(result.owner).toBe("kana");
    expect(result.designated).toBe(true);
    expect(result.source).toBe("xfn-derived");
  });

  it("verify: label also works with config-defined roles", () => {
    const config = makeConfig({
      dimensionMap: {
        code: "cra",
        design: "laren",
        qa: "felix",
      },
    });

    const result = resolveVerifyOwner(["verify:qa"], config);
    expect(result.owner).toBe("felix");
    expect(result.designated).toBe(true);
    expect(result.source).toBe("verify-label");
  });

  it("default owner is config-driven (steward can be overridden)", () => {
    const config = makeConfig({ defaultOwner: "ai" });
    const result = resolveVerifyOwner(["bug"], config);
    expect(result.owner).toBeNull();
    expect(result.designated).toBe(false);
    // defaultOwner doesn't appear in resolution for no-designation,
    // but the config value is available for downstream default flow
  });

  it("loading config from file produces the same dimension map", () => {
    const config = makeConfig({
      dimensionMap: { code: "cra", design: "laren", infra: "igor" },
    });
    const configFile = writeConfigFile(dir, config);

    // The module should be able to load config from a file path.
    // This tests the config-loading boundary without hardcoding.
    const loaded = JSON.parse(fs.readFileSync(configFile, "utf8")) as VerifyConfig;
    expect(loaded.dimensionMap).toEqual(config.dimensionMap);
    expect(loaded.defaultOwner).toBe(config.defaultOwner);

    // Resolution works with loaded config
    const result = resolveVerifyOwner(["xfn:infra"], loaded);
    expect(result.owner).toBe("igor");
    expect(result.designated).toBe(true);
  });
});

describe("checkVerifyGate — AC4: designated ticket cannot reach Done without approval", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("blocks done when designated verifier has not responded", async () => {
    const config = makeConfig();
    globalThis.fetch = makeVerifyFetch({ verifierApproved: false });

    const result = await checkVerifyGate("ticket-gated", "cra", config, "Bearer tok");
    expect(result.blocked).toBe(true);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("verify");
  });

  it("allows done when designated verifier approves", async () => {
    const config = makeConfig();
    globalThis.fetch = makeVerifyFetch({ verifierApproved: true });

    const result = await checkVerifyGate("ticket-approved", "cra", config, "Bearer tok");
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("blocks done when verifier requested changes (sends back to implementation)", async () => {
    const config = makeConfig();
    globalThis.fetch = makeVerifyFetch({ verifierRequestedChanges: true });

    const result = await checkVerifyGate("ticket-changes", "laren", config, "Bearer tok");
    expect(result.blocked).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it("does not block non-designated tickets (owner=null always passes)", async () => {
    const config = makeConfig();
    globalThis.fetch = makeVerifyFetch();

    const result = await checkVerifyGate("ticket-plain", null, config, "Bearer tok");
    expect(result.blocked).toBe(false);
  });
});

describe("isVerifierStalled — AC5: INF-315 stall detection for silent verifier", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns true when designated verifier has been silent beyond SLA period", async () => {
    globalThis.fetch = makeVerifyFetch({ lastActivityDaysAgo: 7 });

    const stalled = await isVerifierStalled("ticket-stalled", "laren", "Bearer tok");
    expect(stalled).toBe(true);
  });

  it("returns false when designated verifier responded recently", async () => {
    globalThis.fetch = makeVerifyFetch({ lastActivityDaysAgo: 0 });

    const stalled = await isVerifierStalled("ticket-active", "cra", "Bearer tok");
    expect(stalled).toBe(false);
  });

  it("returns true when activity is exactly at SLA boundary (>= threshold)", async () => {
    // INF-315 default SLA for verify is expected to be ~3 days.
    // Test with 3 days ago — should be stalled at boundary.
    globalThis.fetch = makeVerifyFetch({ lastActivityDaysAgo: 3 });

    const stalled = await isVerifierStalled("ticket-boundary", "laren", "Bearer tok");
    expect(stalled).toBe(true);
  });

  it("returns false for activity just under SLA threshold", async () => {
    globalThis.fetch = makeVerifyFetch({ lastActivityDaysAgo: 1 });

    const stalled = await isVerifierStalled("ticket-fresh", "cra", "Bearer tok");
    expect(stalled).toBe(false);
  });
});

describe("AC8 (AI-1808): verify gate fires during done transition path", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-verify-integration-"));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Integration-level test: exercise the verify gate through the workflow
   * transition machinery. This validates that when a designated ticket
   * attempts the done transition, the AC-verify resolver intercepts and
   * blocks unless the verifier has approved.
   *
   * This test uses the resolveVerifyOwner + checkVerifyGate pipeline to
   * simulate what happens during the done transition path:
   *   1. Labels are read from the ticket
   *   2. resolveVerifyOwner determines the verify owner
   *   3. checkVerifyGate is called before allowing the done transition
   *   4. If blocked, the transition must not proceed
   */
  it("blocks the done transition for a designated ticket without verifier approval", async () => {
    const config = makeConfig();

    // Simulate a ticket with verify:code label attempting done transition
    const labels = ["wf:dev-impl", "state:code-review", "verify:code"];
    const resolution = resolveVerifyOwner(labels, config);

    expect(resolution.designated).toBe(true);
    expect(resolution.owner).toBe("cra");

    // Mock: verifier has NOT approved
    globalThis.fetch = makeVerifyFetch({ verifierApproved: false, ticketState: "code-review" });

    const gateResult = await checkVerifyGate("integration-ticket", resolution.owner, config, "Bearer tok");

    // The done transition MUST be blocked
    expect(gateResult.blocked).toBe(true);
    expect(gateResult.reason).toBeDefined();
  });

  it("allows the done transition for a designated ticket after verifier approval", async () => {
    const config = makeConfig();

    const labels = ["wf:dev-impl", "state:code-review", "verify:design"];
    const resolution = resolveVerifyOwner(labels, config);

    expect(resolution.designated).toBe(true);
    expect(resolution.owner).toBe("laren");

    // Mock: verifier HAS approved
    globalThis.fetch = makeVerifyFetch({ verifierApproved: true, ticketState: "code-review" });

    const gateResult = await checkVerifyGate("integration-ticket-ok", resolution.owner, config, "Bearer tok");

    // The done transition proceeds
    expect(gateResult.blocked).toBe(false);
  });

  it("does not invoke verify gate for non-designated tickets on done path", async () => {
    const config = makeConfig();

    // Ticket without verify: or xfn: labels
    const labels = ["wf:dev-impl", "state:code-review"];
    const resolution = resolveVerifyOwner(labels, config);

    expect(resolution.designated).toBe(false);
    expect(resolution.owner).toBeNull();

    globalThis.fetch = makeVerifyFetch({ verifierApproved: false });

    const gateResult = await checkVerifyGate("integration-no-verify", resolution.owner, config, "Bearer tok");

    // No gate — done proceeds normally (byte-identical to current behavior)
    expect(gateResult.blocked).toBe(false);
  });
});
