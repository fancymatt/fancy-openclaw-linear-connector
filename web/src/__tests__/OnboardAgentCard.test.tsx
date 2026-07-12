/**
 * AI-2143 — Console onboarding launch + link (AC2 slice of AI-1955).
 *
 * Per Astrid's Option 2 scope call, the console does not drive OAuth over HTTP;
 * it surfaces the CLI onboarding command + a link to the guide. These tests
 * assert both the component in isolation AND that FleetPage actually mounts it
 * (the AI-1954 regression shape — a component nobody renders is a dead AC).
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { OnboardAgentCard } from "../components/OnboardAgentCard";
import { FleetPage } from "../pages/FleetPage";
import type { FleetResponse } from "../types";

const GUIDE_URL =
  "https://github.com/fancymatt/fancy-openclaw-linear-connector#quick-start-onboard-wizard";

describe("AI-2143 — OnboardAgentCard (launch + link)", () => {
  it("surfaces the CLI onboarding command", () => {
    render(<OnboardAgentCard />);
    expect(screen.getByText("npm run onboard")).toBeInTheDocument();
  });

  it("links to the onboarding guide, opening safely in a new tab", () => {
    render(<OnboardAgentCard />);
    const link = screen.getByRole("link", { name: /onboarding guide/i });
    expect(link).toHaveAttribute("href", GUIDE_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("does NOT introduce any onboarding form/HTTP control (Option 2: launch + link only)", () => {
    render(<OnboardAgentCard />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

const emptyFleet: FleetResponse = {
  generatedAt: "2026-07-12T06:00:00.000Z",
  agents: [],
  dispatches: [],
  registryPolicy: { lastCheck: "2026-07-12T06:00:00.000Z", violations: [], notes: [] },
  configHealth: { healthy: true },
};

describe("AI-2143 — FleetPage mounts the onboard card (regression: not just the component in isolation)", () => {
  it("renders the onboard launch point on the fleet page", () => {
    render(
      <MemoryRouter>
        <FleetPage data={emptyFleet} />
      </MemoryRouter>,
    );
    const card = screen.getByRole("heading", { name: "Onboard a new agent" }).closest("section");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("npm run onboard")).toBeInTheDocument();
    expect(
      within(card as HTMLElement).getByRole("link", { name: /onboarding guide/i }),
    ).toHaveAttribute("href", GUIDE_URL);
  });
});
