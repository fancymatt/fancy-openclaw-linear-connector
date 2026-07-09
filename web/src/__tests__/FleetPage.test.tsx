/**
 * AI-1954 — FleetPage ops-actions wiring (regression for the ac-fail where
 * OpsActions existed but no page imported it, so the buttons never rendered in
 * the production SPA).
 *
 * AC4: redispatch button is reachable from the fleet page (page-level, not just
 *      the component in isolation).
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { FleetPage } from "../pages/FleetPage";
import type { FleetResponse } from "../types";

const sampleFleet: FleetResponse = {
  generatedAt: "2026-07-09T06:00:00.000Z",
  agents: [],
  dispatches: [
    {
      id: 1,
      agentId: "sage",
      ticketId: "AI-1954",
      dispatchedAt: "2026-07-09T05:00:00.000Z",
      lastSignalAt: "2026-07-09T05:30:00.000Z",
      ackStatus: "pending",
      attemptCount: 1,
    },
  ],
  registryPolicy: { lastCheck: "2026-07-09T06:00:00.000Z", violations: [], notes: [] },
  configHealth: { healthy: true },
};

function renderPage(data: FleetResponse) {
  return render(
    <MemoryRouter>
      <FleetPage data={data} />
    </MemoryRouter>,
  );
}

describe("AI-1954 AC4 — FleetPage mounts OpsActions (redispatch) per open dispatch", () => {
  it("renders a Redispatch button in the open-dispatch row (not just in the component)", () => {
    renderPage(sampleFleet);
    const row = screen.getByText("AI-1954").closest("tr");
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getByRole("button", { name: /redispatch/i }),
    ).toBeInTheDocument();
  });

  it("links the ticket id to the ticket-detail route", () => {
    renderPage(sampleFleet);
    const link = screen.getByRole("link", { name: "AI-1954" });
    expect(link).toHaveAttribute("href", "/ticket/AI-1954");
  });

  it("does NOT render set-state/recapture/deploy on the fleet row (redispatch-only variant)", () => {
    renderPage(sampleFleet);
    const row = screen.getByText("AI-1954").closest("tr") as HTMLElement;
    expect(within(row).queryByRole("button", { name: /set.?state/i })).toBeNull();
    expect(within(row).queryByRole("button", { name: /recapture/i })).toBeNull();
    expect(within(row).queryByRole("button", { name: /deploy/i })).toBeNull();
  });
});
