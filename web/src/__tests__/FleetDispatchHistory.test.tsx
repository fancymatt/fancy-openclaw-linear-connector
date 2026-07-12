/**
 * AI-1955 AC4 — Per-agent dispatch history with outcome filter.
 *
 * Verifies the component flattens the dispatch-ack store, filters by agent and
 * by outcome, and that the section is reachable from the Fleet page (not just
 * in isolation) — mirroring the AI-1954 page-level wiring regression.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { FleetDispatchHistory } from "../components/FleetDispatchHistory";
import { FleetPage } from "../pages/FleetPage";
import type { DispatchesResponse } from "../pages/DispatchCyclesView";
import type { FleetResponse } from "../types";

const sample: DispatchesResponse = {
  label: "Dispatch cycles",
  cycles: [
    {
      wake_id: "wake-001",
      agent_id: "igor",
      dispatches: [
        { ticket_id: "AI-4001", dispatched_at: "2026-07-11T14:00:00Z", ack_status: "pending", attempt_count: 1 },
      ],
    },
    {
      wake_id: "wake-002",
      agent_id: "sage",
      dispatches: [
        { ticket_id: "AI-4002", dispatched_at: "2026-07-11T14:05:00Z", ack_status: "acknowledged", attempt_count: 1 },
        { ticket_id: "AI-4003", dispatched_at: "2026-07-11T14:06:00Z", ack_status: "escalated", attempt_count: 3 },
      ],
    },
  ],
};

const emptyFleet: FleetResponse = {
  generatedAt: "2026-07-11T15:00:00.000Z",
  agents: [],
  dispatches: [],
  registryPolicy: { lastCheck: "2026-07-11T15:00:00.000Z", violations: [], notes: [] },
  configHealth: { healthy: true },
};

function renderHistory(data: DispatchesResponse) {
  return render(<FleetDispatchHistory data={data} />);
}

describe("AI-1955 AC4 — FleetDispatchHistory", () => {
  it("renders one row per dispatch across all cycles", () => {
    renderHistory(sample);
    expect(screen.getAllByTestId("dispatch-history-row")).toHaveLength(3);
    expect(screen.getByText("AI-4001")).toBeInTheDocument();
    expect(screen.getByText("AI-4003")).toBeInTheDocument();
  });

  it("filters by agent", () => {
    renderHistory(sample);
    fireEvent.change(screen.getByLabelText(/filter dispatch history by agent/i), {
      target: { value: "sage" },
    });
    const rows = screen.getAllByTestId("dispatch-history-row");
    expect(rows).toHaveLength(2);
    expect(screen.queryByText("AI-4001")).not.toBeInTheDocument();
  });

  it("filters by outcome", () => {
    renderHistory(sample);
    fireEvent.change(screen.getByLabelText(/filter dispatch history by outcome/i), {
      target: { value: "escalated" },
    });
    const rows = screen.getAllByTestId("dispatch-history-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("AI-4003")).toBeInTheDocument();
  });

  it("agent + outcome filters compose", () => {
    renderHistory(sample);
    fireEvent.change(screen.getByLabelText(/filter dispatch history by agent/i), {
      target: { value: "sage" },
    });
    fireEvent.change(screen.getByLabelText(/filter dispatch history by outcome/i), {
      target: { value: "acknowledged" },
    });
    const rows = screen.getAllByTestId("dispatch-history-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("AI-4002")).toBeInTheDocument();
  });

  it("shows an empty state when filters exclude everything", () => {
    renderHistory(sample);
    fireEvent.change(screen.getByLabelText(/filter dispatch history by agent/i), {
      target: { value: "igor" },
    });
    fireEvent.change(screen.getByLabelText(/filter dispatch history by outcome/i), {
      target: { value: "acknowledged" },
    });
    expect(screen.queryAllByTestId("dispatch-history-row")).toHaveLength(0);
    expect(screen.getByText(/no dispatches match/i)).toBeInTheDocument();
  });

  it("is reachable from the Fleet page (page-level wiring, not just the component)", () => {
    render(
      <MemoryRouter>
        <FleetPage data={emptyFleet} dispatchHistory={sample} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Dispatch history")).toBeInTheDocument();
    expect(screen.getByText("AI-4003")).toBeInTheDocument();
  });
});
