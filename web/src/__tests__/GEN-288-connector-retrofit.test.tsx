/**
 * GEN-288 — Connector Web UI Retrofit
 *
 * Failing (RED) tests covering all six acceptance criteria for retrofitting the
 * Connector Web UI to consume the @fancyfleet/components design-system package
 * (Button, Nav, Heading, Text).
 *
 * These tests FAIL until @fancyfleet/components is installed AND the App /
 * components source is migrated. The unresolvable import is intentional — it is
 * the RED signal for the TDD cycle. DO NOT mock the design-system package.
 *
 * Test layout follows the project convention:
 *   describe("TICKET-ID AC# — description", () => { it("...", () => {}) })
 * Each AC is a separate describe block; the integration test (AC6) boots the
 * real <App /> via MemoryRouter with fetch stubbed, mirroring the pattern in
 * ProposalsNav.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// These imports WILL FAIL until @fancyfleet/components is added to package.json.
// The failure is the RED signal — do NOT mock these modules.

import { App } from "../App";
import { Tabs } from "../components";

// ---------------------------------------------------------------------------
// Shared fixtures (mirrors the stubs used by ProposalsNav.test.tsx so the App
// can boot to an authenticated shell without hitting the network).
// ---------------------------------------------------------------------------

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

// Theme.css source — read once synchronously so AC4 can assert on the raw CSS.
const themeCssPath = resolve(__dirname, "../theme.css");
const themeCss: string = readFileSync(themeCssPath, "utf-8");

beforeEach(() => {
  mockApi();
  // BrowserRouter inside <App /> uses basename="/admin", so the window URL
  // must start with "/admin" for the router to match any route.
  window.history.pushState({}, "", "/admin/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

// ---------------------------------------------------------------------------
// AC1 — Button: Sign-out button uses <Button> from @fancyfleet/components
// ---------------------------------------------------------------------------

describe("GEN-288 AC1 — Sign-out button uses Button from @fancyfleet/components", () => {
  it("renders the sign-out control as a <Button> component, not a raw <button>", async () => {
    render(<App />);
    // The authenticated shell renders a Sign out control. After the retrofit it
    // must originate from @fancyfleet/components — asserted via the component's
    // stable data attribute (data-ff="button") that the library sets on every
    // Button render.
    const signOut = await screen.findByRole("button", { name: /sign out/i });
    expect(signOut).toHaveAttribute("data-ff", "button");
  });

  it("passes a supported variant to the Button (primary | secondary | ghost)", async () => {
    render(<App />);
    const signOut = await screen.findByRole("button", { name: /sign out/i });
    // A sign-out control is a tertiary action; the retrofit must pass an
    // explicit variant. The library surfaces it as data-variant.
    const variant = signOut.getAttribute("data-variant");
    expect(["primary", "secondary", "ghost"]).toContain(variant);
  });

  it("still triggers logout when clicked", async () => {
    render(<App />);
    const signOut = await screen.findByRole("button", { name: /sign out/i });
    fireEvent.click(signOut);
    // After logout the App flips back to anonymous, which renders the login
    // screen instead of the console shell. Wait for the heading to disappear.
    await screen.findByRole("heading", { name: /^linear connector$/i });
    expect(screen.queryByRole("heading", { name: /linear connector console/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC2 — Nav: Tabs renders using <Nav> from @fancyfleet/components
// ---------------------------------------------------------------------------

describe("GEN-288 AC2 — Tabs renders using Nav from @fancyfleet/components", () => {
  it("renders a <Nav> component with data-ff=\"nav\" on its container", () => {
    render(
      <MemoryRouter>
        <Tabs />
      </MemoryRouter>,
    );
    // After the retrofit the outermost nav element must come from the library.
    const navRoot = document.querySelector('[data-ff="nav"]');
    expect(navRoot).not.toBeNull();
  });

  it("renders all the expected routes as nav items", () => {
    render(
      <MemoryRouter>
        <Tabs />
      </MemoryRouter>,
    );
    const expectedLabels = [
      "Overview",
      "Fleet",
      "Board",
      "Tasks",
      "Events",
      "Alerts",
      "Workflows",
      "Proposals",
      "Dead Letters",
      "Stalls",
      "Webhooks",
    ];
    for (const label of expectedLabels) {
      expect(screen.getByRole("link", { name: new RegExp(label, "i") })).toBeInTheDocument();
    }
  });

  it("marks the active route via the Nav component's active handling", () => {
    render(
      <MemoryRouter initialEntries={["/fleet"]}>
        <Tabs />
      </MemoryRouter>,
    );
    const fleetLink = screen.getByRole("link", { name: /^fleet$/i });
    // The Nav component from @fancyfleet/components stamps the active item with
    // aria-current="page" (the library's contract for active routes).
    expect(fleetLink).toHaveAttribute("aria-current", "page");
  });

  it("still shows the pending badge on the Proposals entry", () => {
    render(
      <MemoryRouter>
        <Tabs pendingProposals={5} />
      </MemoryRouter>,
    );
    const proposalsLink = screen.getByRole("link", { name: /proposals/i });
    expect(within(proposalsLink).getByTestId("nav-pending-badge")).toHaveTextContent("5");
  });
});

// ---------------------------------------------------------------------------
// AC3 — Typography: heading and subtitle use <Heading> and <Text>
// ---------------------------------------------------------------------------

describe("GEN-288 AC3 — Typography components render the console title block", () => {
  it("renders the h1 via <Heading> from @fancyfleet/components", async () => {
    render(<App />);
    const heading = await screen.findByRole("heading", { level: 1, name: /linear connector console/i });
    // The library's Heading stamps its rendered element with data-ff="heading".
    expect(heading).toHaveAttribute("data-ff", "heading");
  });

  it("renders the subtitle via <Text> from @fancyfleet/components", async () => {
    render(<App />);
    const subtitle = await screen.findByText(/workflow engine.*fleet routing.*operational health/i);
    // The Text component's rendered element carries data-ff="text".
    expect(subtitle).toHaveAttribute("data-ff", "text");
  });
});

// ---------------------------------------------------------------------------
// AC4 — Lighter surface adaptation (CSS custom properties)
// ---------------------------------------------------------------------------

describe("GEN-288 AC4 — Connector CSS custom properties override Gen defaults for surfaces", () => {
  it("defines --bg in theme.css with a lighter value than Gen's Editorial Dark baseline (#0b0f14 vs #05070a)", () => {
    // Gen's default Editorial Dark palette uses --bg: #05070a. The connector
    // overrides it with a lighter value. We assert the exact lighter value
    // that the connector's theme.css declares today.
    expect(themeCss).toMatch(/--bg\s*:\s*#0b0f14\s*;/);
    expect(themeCss).toMatch(/--panel\s*:\s*#111821\s*;/);
  });

  it("imports Gen's default tokens but overrides surface backgrounds after the import", () => {
    // After the retrofit theme.css should pull in @fancyfleet/components/tokens
    // and then re-declare --bg and --panel with the connector's lighter values.
    // The ordering matters: connector values must come AFTER the import so they
    // win the cascade.
    const importIdx = themeCss.indexOf("@fancyfleet/components/tokens");
    // If there is no import, the test fails — the retrofit must add it.
    expect(importIdx).toBeGreaterThanOrEqual(0);
    const bgIdx = themeCss.indexOf("--bg:", importIdx);
    expect(bgIdx).toBeGreaterThan(importIdx);
  });
});

// ---------------------------------------------------------------------------
// AC5 — Graceful mixing: retrofitted and legacy components coexist
// ---------------------------------------------------------------------------

describe("GEN-288 AC5 — Retrofitted and legacy components coexist in the route tree", () => {
  it("renders a design-system <Button> alongside legacy raw <button> elements without crashing", async () => {
    render(<App />);
    // Wait for the authenticated shell (the sign-out Button proves the library
    // is mounted in the tree).
    const signOut = await screen.findByRole("button", { name: /sign out/i });
    expect(signOut).toHaveAttribute("data-ff", "button");
    // Pages still using raw <button> elements must render without throwing. The
    // OverviewPage is the default landing route; if it or any sibling rendered
    // a raw <button> that broke under the new tree, the App would have thrown
    // during findByRole above. We additionally assert the shell heading is present.
    expect(screen.getByRole("heading", { name: /linear connector console/i })).toBeInTheDocument();
  });

  it("renders a design-system <Nav> alongside the legacy <Card> component on the same page", async () => {
    render(<App />);
    // Nav from @fancyfleet/components is in the shell; Card from components.tsx
    // is used inside OverviewPage. Both must coexist.
    await screen.findByRole("heading", { name: /linear connector console/i });
    const navRoot = document.querySelector('[data-ff="nav"]');
    expect(navRoot).not.toBeNull();
    // Card renders as <section class="card ..."> — at least one should be
    // present on the Overview route.
    const cards = document.querySelectorAll("section.card");
    expect(cards.length).toBeGreaterThan(0);
  });

  it("coexists: App shell renders retrofitted components while OverviewPage renders legacy Card components", async () => {
    // Rather than navigating between routes (each page has its own API shape),
    // assert that the Overview route — which uses legacy Card/Stat components —
    // renders fine inside the retrofitted shell that uses Button/Nav/Heading.
    render(<App />);
    const heading = await screen.findByRole("heading", { level: 1, name: /linear connector console/i });
    // Shell is retrofitted (library component):
    expect(heading).toHaveAttribute("data-ff", "heading");
    // OverviewPage body still uses legacy Card — at least one renders:
    const cards = document.querySelectorAll("section.card");
    expect(cards.length).toBeGreaterThan(0);
    // And the legacy Card has NOT been retrofitted (no data-ff on it):
    expect(cards[0]).not.toHaveAttribute("data-ff");
  });
});

// ---------------------------------------------------------------------------
// AC6 (AI-1808 bootstrap rule) — Integration test on the production entry point
// ---------------------------------------------------------------------------

describe("GEN-288 AC6 (AI-1808) — Full App tree boots and renders retrofitted components", () => {
  it("boots <App /> and renders the <Heading> console title via @fancyfleet/components", async () => {
    render(<App />);
    const heading = await screen.findByRole("heading", { level: 1, name: /linear connector console/i });
    expect(heading).toHaveAttribute("data-ff", "heading");
  });

  it("boots <App /> and renders the <Nav> component in the shell", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: /linear connector console/i });
    const navRoot = document.querySelector('[data-ff="nav"]');
    expect(navRoot).not.toBeNull();
  });

  it("boots <App /> and renders the <Button> component for sign-out", async () => {
    render(<App />);
    const signOut = await screen.findByRole("button", { name: /sign out/i });
    expect(signOut).toHaveAttribute("data-ff", "button");
  });

  it("renders all three retrofitted components (Heading, Nav, Button) in a single boot", async () => {
    render(<App />);
    // One boot, three assertions — proves they coexist in the same tree.
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading).toHaveAttribute("data-ff", "heading");
    expect(document.querySelector('[data-ff="nav"]')).not.toBeNull();
    const signOut = screen.getByRole("button", { name: /sign out/i });
    expect(signOut).toHaveAttribute("data-ff", "button");
  });
});
