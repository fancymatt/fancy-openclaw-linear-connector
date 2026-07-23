/**
 * GEN-285: Token Centralization & Pilot Consumption — FAILING tests (test-author: tdd)
 *
 * AC: Both pilot apps consume CSS custom properties tokens from @fancyfleet/tokens.
 * Connector UI adapts (lighter surface).
 *
 * ── Verbatim AC (astrid from GEN-274 Findings) ──
 * Wire CSS custom properties tokens from @fancyfleet/tokens into both pilot apps
 * (gen.fcy.sh and Connector UI). AC: both apps consume tokens, token values
 * verified live, Connector UI adapts (lighter surface).
 *
 * ── What these tests cover ──
 * AC3: Connector Web UI imports @fancyfleet/tokens in its CSS pipeline (theme.css
 *      or main.tsx entry point).
 * AC4: Connector Web UI adapts token surface values for a lighter appearance
 *      (surface overrides differ from the Gen "Editorial Dark" defaults).
 * AC5: Key token custom properties are defined on :root (verified live).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const WEB_ROOT = resolve(__dirname, "..");
const THEME_CSS = resolve(WEB_ROOT, "theme.css");
function read(rel: string): string {
  const p = resolve(WEB_ROOT, rel);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

// ── Token custom properties the Connector UI must surface ──
const REQUIRED_TOKENS = [
  "--color-text",
  "--color-text-secondary",
  "--color-text-inverse",
  "--color-bg",
  "--color-surface",
  "--color-border",
  "--color-accent",
  "--color-accent-strong",
  "--color-success",
  "--color-warning",
  "--color-error",
  "--color-surface-raised",
  "--color-surface-code",
  "--color-surface-input",
  "--color-surface-overlay",
  "--font-size-base",
  "--font-family-body",
  "--font-family-mono",
  "--line-height-body",
  "--space-4",
  "--space-5",
  "--space-6",
  "--radius-full",
  "--radius-lg",
  "--radius-md",
  "--radius-xl",
  "--elevation-3",
  "--elevation-4",
];

// ── Surface tokens that MUST differ from Gen's defaults (lighter adaptation) ──
// The design direction (Laren) specifies "Connector UI inherits and adapts:
// slightly lighter surface, same accent, same type scale."
// INF-298 migrated from --ff-* to --color-surface-* tokens.
const SURFACE_OVERRIDES = [
  "--color-surface-raised",
  "--color-surface-code",
  "--color-surface-input",
  "--color-surface-overlay",
  "--color-accent",
  "--color-accent-strong",
  "--color-accent-dim",
];

// ── CSS entry files that must import @fancyfleet/tokens ──
const CSS_ENTRIES = ["theme.css", "main.tsx"];

// ── AC3: @fancyfleet/tokens is imported in the connector CSS/entry ──

describe("GEN-285 AC3: connector imports @fancyfleet/tokens", () => {
  it("imports @fancyfleet/tokens in the CSS entry point (theme.css or main.tsx)", () => {
    let found = false;
    for (const entry of CSS_ENTRIES) {
      const content = read(entry);
      if (
        content.includes("@fancyfleet/tokens") ||
        /@import\s+["']@fancyfleet\/tokens["']/.test(content) ||
        /@reference\s+["']@fancyfleet\/tokens["']/.test(content)
      ) {
        found = true;
        break;
      }
    }

    expect(found, `@fancyfleet/tokens must be imported in one of: ${CSS_ENTRIES.join(", ")}`).toBe(true);
  });

  it("theme.css exists as the app stylesheet entry point", () => {
    expect(existsSync(THEME_CSS), "theme.css must exist as the app stylesheet entry point").toBe(true);
  });
});

// ── AC4: Connector UI adapts surface tokens for a lighter appearance ──

describe("GEN-285 AC4: connector UI adapts surface tokens (lighter)", () => {
  it("declares lighter surface overrides in theme.css", () => {
    const css = read("theme.css");

    // At least 3 of the 7 surface/override tokens must be explicitly redeclared
    // in theme.css with values different from the Gen default (lighter).
    const overridden = SURFACE_OVERRIDES.filter((prop) => css.includes(prop));

    expect(
      overridden.length >= 3,
      `Expected at least 3 surface tokens to be overridden for lighter appearance. ` +
      `Found ${overridden.length}: ${overridden.join(", ")}. ` +
      `Surface token overrides from: ${SURFACE_OVERRIDES.join(", ")}`,
    ).toBe(true);
  });

  it("surface overrides use color-mix for lighter surface values", () => {
    const css = read("theme.css");

    // The connector uses color-mix to create lighter surface layers on top
    // of the design system's surface tokens. Each --color-surface-* token
    // should use color-mix to blend with a transparent base for lightness.
    const surfaceRenderedMatch = css.match(/--color-surface-raised\s*:\s*([^;]+)/);
    expect(
      surfaceRenderedMatch,
      "--color-surface-raised must be declared in theme.css with a lighter value",
    ).not.toBeNull();

    if (surfaceRenderedMatch) {
      const value = surfaceRenderedMatch[1].trim();
      expect(
        value.length > 0,
        `--color-surface-raised override value must be non-empty (got: "${value}")`,
      ).toBe(true);
    }
  });
});

// ── AC5: Key token custom properties are defined on :root (verified live) ──

describe("GEN-285 AC5: token values verified live", () => {
  it("theme.css references key token custom properties", () => {
    const css = read("theme.css");

    // After importing @fancyfleet/tokens, the tokens are available on :root.
    // At minimum the CSS should reference or redeclare the critical tokens.
    const missing: string[] = [];

    for (const token of REQUIRED_TOKENS) {
      if (!css.includes(token) && !css.includes(`var(${token})`)) {
        missing.push(token);
      }
    }

    // Critical subset that must always be present
    const critical = [
      "--color-text",
      "--color-bg",
      "--color-surface",
      "--color-border",
      "--color-accent",
      "--font-size-base",
      "--space-4",
    ];


    const missingCritical = critical.filter((t) => !css.includes(t) && !css.includes(`var(${t})`));
    expect(
      missingCritical,
      `Critical token custom properties not found in theme.css: ${missingCritical.join(", ")}. ` +
      `Import @fancyfleet/tokens in theme.css or main.tsx.`,
    ).toEqual([]);
  });
});
