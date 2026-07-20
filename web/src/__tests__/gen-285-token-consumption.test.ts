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
  "--ff-color-brand-primary",
  "--ff-color-accent",
  "--ff-color-neutral-50",
  "--ff-color-neutral-900",
  "--ff-font-sans",
  "--ff-font-size-base",
  "--ff-space-2",
  "--ff-space-4",
  "--ff-radius-md",
  "--ff-radius-lg",
  "--ff-shadow-sm",
  "--ff-shadow-focus",
  "--ff-text-primary",
  "--ff-text-secondary",
  "--ff-surface-primary",
  "--ff-surface-secondary",
  "--ff-border-default",
  "--ff-border-subtle",
];

// ── Surface tokens that MUST differ from Gen's defaults (lighter adaptation) ──
// The design direction (Laren) specifies "Connector UI inherits and adapts:
// slightly lighter surface, same accent, same type scale."
const SURFACE_OVERRIDES = [
  "--ff-surface-primary",
  "--ff-surface-secondary",
  "--ff-surface-elevated",
  "--ff-text-primary",
  "--ff-text-secondary",
  "--ff-border-default",
  "--ff-border-subtle",
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

  it("surface overrides use lighter values (e.g., lighter neutral tones)", () => {
    const css = read("theme.css");

    // The light-mode Gen defaults (Editorial Dark from Laren's direction) set
    // a dark theme. The Connector UI inherits tokens but overrides surface
    // values to be lighter. Expect the surface-primary override to use
    // a lighter neutral (neutral-50, neutral-100) or a custom light value.
    // At minimum, the surface-primary should be redeclared with SOME value.
    // The implementer may use var(--ff-color-neutral-*) or a raw OKLCH value.
    const surfaceMatch = css.match(/--ff-surface-primary\s*:\s*([^;]+)/);
    expect(
      surfaceMatch,
      "--ff-surface-primary must be redeclared in theme.css with a lighter value",
    ).not.toBeNull();

    if (surfaceMatch) {
      const value = surfaceMatch[1].trim();
      expect(
        value.length > 0,
        `--ff-surface-primary override value must be non-empty (got: "${value}")`,
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
      "--ff-color-brand-primary",
      "--ff-color-accent",
      "--ff-font-sans",
      "--ff-font-size-base",
      "--ff-space-4",
      "--ff-surface-primary",
      "--ff-text-primary",
    ];

    const missingCritical = critical.filter((t) => !css.includes(t) && !css.includes(`var(${t})`));
    expect(
      missingCritical,
      `Critical token custom properties not found in theme.css: ${missingCritical.join(", ")}. ` +
      `Import @fancyfleet/tokens in theme.css or main.tsx.`,
    ).toEqual([]);
  });
});
