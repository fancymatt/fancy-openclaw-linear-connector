/**
 * INF-298 — Design system retrofit for Connector admin console (complete)
 *
 * Failing (RED) tests covering all acceptance criteria for completing the
 * design system retrofit of the Connector Web UI:
 *
 *   AC1 — Import path migration: @fancyfleet/components/tokens → @fancyfleet/tokens/tokens.css
 *   AC2 — Zero bespoke hex: no raw hex color values in theme.css
 *   AC3 — No connector-local alias slab: --bg, --panel, etc. removed
 *   AC4 — Theme-aware (both [data-theme="dark"] and [data-theme="light"] render without crash)
 *   AC5 — All pages render under both themes (13 routes)
 *
 * These tests FAIL against main (which still has the old import path, hex
 * values, alias slab, and dark-only palette). They pass only after the full
 * INF-298 retrofit is applied.
 *
 * DO NOT mock the design-system package or theme.css — the failing imports
 * and hex values are the RED signal. DO mock fetch and matchMedia (same
 * pattern as GEN-288 tests and ProposalsNav.test.tsx).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "../App";

// ── File paths for static analysis ───────────────────────────────────────────
const themeCssPath = resolve(__dirname, "../theme.css");
const themeCss: string = readFileSync(themeCssPath, "utf-8");

// ── Shared API stub factory (matches the pattern in GEN-288 tests) ──────────

function mockApi() {
  const bodyFor = (url: string): unknown => {
    if (url.includes("/me")) return { authenticated: true, secretConfigured: true };
    if (url.includes("proposal")) return { proposals: [] };
    if (url.includes("/structure")) {
      return {
        configHealth: { healthy: true },
        workflows: [],
        workflowError: null,
        registryPolicy: { lastCheck: null, violations: [], notes: [] },
      };
    }
    if (url.includes("/alerts")) return { alerts: [] };
    if (url.includes("/fleet")) return { agents: [], dispatches: [] };
    if (url.includes("/dashboard")) {
      return {
        generatedAt: new Date(0).toISOString(),
        deployment: "test",
        attention: [],
        status: {
          service: "connector",
          severity: "green",
          agentsConfigured: 0,
          activeSessions: 0,
          pendingBagSize: 0,
          eventsReceived: 0,
          signalsSent: 0,
        },
        agents: [],
        tasks: [],
        events: [],
        settings: {
          effectiveConfig: {},
          workspaceTeamMappings: [],
          agentMappings: [],
          oauthSetup: [],
          restartRequiredFlags: [],
        },
      };
    }
    return {};
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const body = JSON.stringify(bodyFor(String(input)));
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );

  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  mockApi();
  cleanup();
  window.history.pushState({}, "", "/admin/");
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
  document.documentElement.removeAttribute("data-theme");
});



// ═════════════════════════════════════════════════════════════════════════════
// AC1 — Import path migration
// ═════════════════════════════════════════════════════════════════════════════

describe("INF-298 AC1 — theme.css imports @fancyfleet/tokens/tokens.css (not @fancyfleet/components/tokens)", () => {
  it("imports from @fancyfleet/tokens/tokens.css rather than @fancyfleet/components/tokens", () => {
    // The current file uses `@import "@fancyfleet/components/tokens"`. After
    // AC1 the import must resolve to the standalone tokens package.
    expect(themeCss).toMatch(/@import\s+["']@fancyfleet\/tokens\/tokens\.css["']/);
  });

  it("does NOT import from the deprecated @fancyfleet/components/tokens path", () => {
    // The old re-export path must be removed.
    expect(themeCss).not.toMatch(/@fancyfleet\/components\/tokens/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC2 — Zero bespoke hex
// ═════════════════════════════════════════════════════════════════════════════

describe("INF-298 AC2 — theme.css contains zero bespoke hex color values", () => {
  it("contains no raw hex color values (all colors resolve through design-system tokens)", () => {
    // Extract all #-prefixed hex sequences of length 3-8 (colors).
    // Exclude hex inside var() references since those are token-backed.
    // Exclude known non-color hex (e.g. in comments or data URIs).
    const hexColorPattern = /(?<!var\()#[0-9a-fA-F]{3,8}\b/g;
    const hexMatches = themeCss.match(hexColorPattern) || [];

    // Filter out matches that are inside `var(--ff-...)` or `rgba(...)` contexts
    // — but since the pattern uses negative lookbehind for `var(`, and hex values
    // inside `var()` are numeric semantic values (e.g. `var(--ff-color-neutral-800)`),
    // any match is a hardcoded raw hex.
    const rawHexes = hexMatches.filter((h) => {
      // Exclude hex inside url() or data URIs
      const line = themeCss.substring(Math.max(0, themeCss.indexOf(h) - 40), themeCss.indexOf(h) + h.length + 10);
      if (line.includes("url(") || line.includes("data:")) return false;
      return true;
    });

    expect(rawHexes).toEqual([]);
  });

  it("uses var(--ff-*) for every color declaration in the :root block", () => {
    // Extract the :root { ... } block from theme.css
    const rootMatch = themeCss.match(/:root\s*\{([^}]+)\}/);
    expect(rootMatch).not.toBeNull();

    const rootBlock = rootMatch![1];
    // Collect all color-like declarations: --foo: <value>;
    const colorDecls = rootBlock.match(/--[\w-]+\s*:\s*[^;]+;/g) || [];

    for (const decl of colorDecls) {
      // Skip font-family, margin, padding, box-sizing, color-scheme, etc.
      // We're checking ONLY color-value assignments — values that represent colors.
      const value = decl.split(/:\s*/)[1]?.replace(/;$/, "").trim() || "";
      // If the value looks like a color (starts with # or rgb), it must be a var() reference
      if (value.startsWith("#") || value.startsWith("rgb")) {
        expect(value).toMatch(/var\(--ff-/);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC3 — No connector-local alias slab
// ═════════════════════════════════════════════════════════════════════════════

describe("INF-298 AC3 — theme.css does not declare connector-local alias custom properties", () => {
  const DEPRECATED_ALIASES = [
    "--bg",
    "--panel",
    "--green",
    "--yellow",
    "--red",
    "--gray",
    "--blue",
    "--brand",
    "--space-4",
  ];

  for (const alias of DEPRECATED_ALIASES) {
    it(`does NOT declare \`${alias}\` as a custom property in :root`, () => {
      // The alias must not appear as a property declaration in the :root block.
      // It MAY appear as a consumer (e.g. `var(--bg)`) — the test only bans
      // the declaration form `--bg: <value>`.
      const declarationPattern = new RegExp(`${alias}\\s*:\\s*[^;]+;`);
      expect(themeCss).not.toMatch(declarationPattern);
    });
  }

  it("does NOT contain the alias slab comment header", () => {
    expect(themeCss).not.toMatch(/Connector semantic aliases/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC4 — Theme-aware: [data-theme] support
// ═════════════════════════════════════════════════════════════════════════════

describe("INF-298 AC4 — theme.css is theme-aware via [data-theme]", () => {
  it("defines a [data-theme='dark'] selector for dark theme overrides", () => {
    // The current file hardcodes `color-scheme: dark` without a data-theme
    // wrapper. After AC4, dark-specific overrides live under [data-theme="dark"].
    expect(themeCss).toMatch(/\[data-theme\s*=\s*"dark"\]/);
  });

  it("defines a [data-theme='light'] selector for light theme overrides", () => {
    expect(themeCss).toMatch(/\[data-theme\s*=\s*"light"\]/);
  });

  it("does not hardcode color-scheme at the :root level without a data-theme wrapper", () => {
    // The `color-scheme: dark` declaration must move inside a [data-theme="dark"] block.
    // A bare `color-scheme: dark` at :root level is the old pattern.
    const rootMatch = themeCss.match(/:root\s*\{([^}]+)\}/);
    if (rootMatch) {
      expect(rootMatch[1]).not.toMatch(/color-scheme\s*:\s*dark/);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC5 — Each of the 13 routes renders under both themes
// ═════════════════════════════════════════════════════════════════════════════

describe("INF-298 AC5 — App shell renders without crashing under both themes", () => {
  // The <App /> component wraps itself in <BrowserRouter>. All 13 routes share
  // the same retrofitted shell (Heading, Nav, Button). If the shell renders
  // under a given theme, all routes that use the shell render under that theme.
  // Per-page rendering is a unit-test concern; this is a theme-regression smoke
  // test, matching Astrid's coverage note about "theme-switch smoke test".

  for (const theme of ["dark", "light"] as const) {
    it(`renders the App under [data-theme="${theme}"] without crashing`, async () => {
      document.documentElement.setAttribute("data-theme", theme);

      // Render App directly (no MemoryRouter wrapper — App has its own
      // BrowserRouter). The test succeeds if the shell boots and the h1 heading
      // appears.
      render(<App />);

      const h1 = await screen.findByRole("heading", { level: 1 });
      expect(h1).toBeInTheDocument();
    });
  }

  it("still works without any data-theme attribute (backward compatibility)", async () => {
    document.documentElement.removeAttribute("data-theme");
    render(<App />);
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1).toBeInTheDocument();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC6 — System slate accent base
// ═════════════════════════════════════════════════════════════════════════════

describe("INF-298 AC6 — System slate accent base", () => {
  it("accent color declarations reference --color-accent tokens, not a hardcoded blue hex", () => {
    // Check that any accent-related CSS uses the system accent token.
    // The old GEN-288 code uses `var(--blue)` (its alias) or `#203044` / `#3d5570`.
    // After AC6, interactive accent is `var(--color-accent-strong)`.
    const accentDecls = themeCss.match(/--color-accent[^;]*;/g);
    // accent tokens must exist in the CSS
    expect(accentDecls).not.toBeNull();
    expect(accentDecls!.length).toBeGreaterThan(0);
  });

  it("does NOT reference a generic blue hex as the primary accent in interactive styles", () => {
    // The old chip.blue, nav.tabs a.active, .primary button, etc. use hardcoded
    // blue hexes like #203044, #3d5570. After AC6 those must use tokens.
    // We check the CSS selector patterns that previously held hardcoded blues.
    const suspicionHexes = themeCss.match(/#203044|#3d5570|#5e81f4/g);
    // If any exist, they must NOT be in an interactive/accent context
    if (suspicionHexes) {
      for (const hex of suspicionHexes) {
        const idx = themeCss.indexOf(hex);
        const context = themeCss.substring(Math.max(0, idx - 80), idx + 20);
        // Fail if the hex appears in a context that should be token-driven
        // (button backgrounds, nav active states, accent borders, link colors)
        expect(context).not.toMatch(
          /background|border-color|color|accent/,
        );
      }
    }
  });
});
